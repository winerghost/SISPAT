"""Registro do ÚLTIMO LOGIN do usuário (`users.last_login_at`).

Problema que este módulo resolve: a coluna `users.last_login_at` existe desde
a migração 0001 e é LIDA em dois lugares (`user_admin_service.user_summary` e
a allowlist de ordenação `_SORTS`), mas NENHUM ponto do backend a escrevia —
em produção ela estava `NULL` para todos os usuários. Sem ela, nem o ADM nem
o próprio titular conseguem notar uma conta em uso indevido.

SEMÂNTICA: "último LOGIN", não "última atividade"
    O instante gravado é o do PRIMEIRO FATOR DE AUTENTICAÇÃO DA SESSÃO, lido
    do claim `amr` do JWT (`min` dos `timestamp`) — o mesmo claim e o mesmo
    parser (`app.auth.supabase_auth._strict_amr_timestamps`) já usados pela
    defesa de sessões revogadas (UA-SESS-01/02). Esse valor é PRESERVADO nos
    refreshes do access token, então:

      - toda requisição da MESMA sessão calcula o MESMO instante;
      - o `UPDATE` é condicional (`last_login_at < quando`), logo a segunda
        requisição da sessão não grava nada (0 linhas afetadas);
      - resultado: ~1 escrita por LOGIN, não uma por requisição.

    Fallback (`amr` ausente ou malformado — situação prevista na docstring de
    `app.auth.supabase_auth`): usa `now()` com janela mínima de
    `FALLBACK_MIN_INTERVAL_SECONDS`, para que o pior caso continue sendo uma
    escrita por janela, e não uma por requisição. Nesse modo a semântica
    degrada para "primeiro acesso visto na janela".

    Um instante absurdo (muito antigo ou no futuro) é descartado e cai no
    fallback — nunca se grava um valor vindo cru do token.

AUDITORIA
    Quando — e SOMENTE quando — o `UPDATE` condicional realmente grava
    (`rowcount > 0`), uma linha `LOGIN` é inserida em `audit_logs` NA MESMA
    TRANSAÇÃO. O dedupe é consequência do próprio `UPDATE`: uma linha por
    sessão, nunca uma por requisição. `entity_type="auth"` e
    `operation="LOGIN"` seguem `docs/architecture/estrategia-auditoria.md`
    §2.2; `result` é `"SUCESSO"` porque o CHECK `ck_audit_logs_result` só
    aceita `SUCESSO`/`FALHA` (o `'DENIED'` previsto no documento é impossível
    no banco — drift do documento, não do código). Nenhum token, claim bruto,
    e-mail ou IP é gravado: só o `aal` da sessão (`aal1`/`aal2`).

CONTROLE OTIMISTA E `updated_at`
    O `UPDATE` toca SOMENTE `last_login_at` e NÃO incrementa `users.version`:
    `version` não é `version_id_col` do mapper (ver `app.models.rbac.User`),
    é comparado explicitamente pela camada de serviço. Isso é deliberado — um
    login não pode invalidar (409) o formulário de edição que um ADM tem
    aberto. Como efeito colateral do `TimestampMixin`
    (`onupdate=utcnow`), `users.updated_at` é renovado; nenhuma consulta do
    projeto lê `User.updated_at`.

FALHA NUNCA QUEBRA A AUTENTICAÇÃO
    Quem chama (`app.auth.supabase_auth.require_auth`) envolve tudo em
    `try/except` e segue adiante: registrar o login é melhor-esforço.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from app.authorization.security_events import get_request_id
from app.models.audit import AuditLog
from app.models.rbac import User

logger = logging.getLogger(__name__)

# `operation`/`entity_type` da linha de auditoria (ver docstring do módulo).
OP_LOGIN = "LOGIN"
AUDIT_ENTITY_TYPE = "auth"
# `ck_audit_logs_result` só aceita SUCESSO/FALHA.
_AUDIT_RESULT = "SUCESSO"

# Janela mínima entre gravações quando NÃO há instante de sessão utilizável.
FALLBACK_MIN_INTERVAL_SECONDS = 900  # 15 min

# Limites de sanidade do instante lido do claim `amr`.
_MAX_SESSION_AGE_SECONDS = 365 * 24 * 60 * 60
_FUTURE_SKEW_SECONDS = 60


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: Any) -> datetime | None:
    """`datetime` normalizado para UTC (naive = UTC); qualquer outra coisa -> None."""
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def session_started_at(claims: Any, *, now: datetime | None = None) -> datetime | None:
    """Instante do PRIMEIRO fator de autenticação da sessão, em UTC.

    `None` quando o claim `amr` está ausente/malformado (falha fechada do
    parser compartilhado) ou quando o instante está fora dos limites de
    sanidade — nesses casos quem chama usa o fallback.
    """
    if not isinstance(claims, dict):
        return None
    # Import local DE PROPÓSITO: `app.auth.supabase_auth` importa este
    # módulo, e o parser do `amr` mora lá (fonte única da regra). O import no
    # topo criaria um ciclo de importação.
    from app.auth.supabase_auth import _strict_amr_timestamps

    timestamps = _strict_amr_timestamps(claims)
    if not timestamps:
        return None
    started = min(timestamps)
    current = (now or _utcnow()).timestamp()
    if not (current - _MAX_SESSION_AGE_SECONDS <= started <= current + _FUTURE_SKEW_SECONDS):
        return None
    try:
        return datetime.fromtimestamp(started, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def resolve_login_instant(claims: Any, *, now: datetime | None = None) -> tuple[datetime, int]:
    """`(instante a gravar, janela mínima em segundos)` — ver docstring do módulo."""
    current = now or _utcnow()
    started = session_started_at(claims, now=current)
    if started is not None:
        return started, 0
    return current, FALLBACK_MIN_INTERVAL_SECONDS


def _cutoff(when: datetime, min_interval_seconds: int) -> datetime:
    try:
        interval = max(0, int(min_interval_seconds))
    except (TypeError, ValueError):
        interval = 0
    return when - timedelta(seconds=interval)


def should_record_login(
    stored: Any, when: datetime, min_interval_seconds: int = 0
) -> bool:
    """Pré-checagem em memória (evita ida ao banco no caso comum).

    O valor de `users.last_login_at` já veio na consulta de autenticação, logo
    dá para decidir sem nenhum SELECT extra. A condição é repetida no `WHERE`
    do `UPDATE` (ver `record_login`), que é a garantia real contra corrida.
    """
    current = as_utc(stored)
    return current is None or current < _cutoff(when, min_interval_seconds)


def record_login(
    db: Session,
    user_id: uuid.UUID,
    when: datetime,
    *,
    min_interval_seconds: int = 0,
    aal: str | None = None,
) -> bool:
    """Grava `last_login_at` e, SÓ se gravou, a linha `LOGIN` em `audit_logs`.

    Retorna `True` quando o `UPDATE` afetou a linha (login novo) e `False`
    quando não havia nada a gravar (outra requisição da mesma sessão, ou
    janela do fallback ainda aberta). Idempotente e seguro sob concorrência:
    a condição está no `WHERE`, então o segundo gravador vê 0 linhas.
    """
    target = _cutoff(when, min_interval_seconds)
    result = db.execute(
        update(User)
        .where(
            User.id == user_id,
            or_(User.last_login_at.is_(None), User.last_login_at < target),
        )
        .values(last_login_at=when)
        .execution_options(synchronize_session=False)
    )
    if int(result.rowcount or 0) <= 0:
        return False

    db.add(
        AuditLog(
            id=uuid.uuid4(),
            actor_user_id=user_id,
            entity_type=AUDIT_ENTITY_TYPE,
            entity_id=str(user_id),
            operation=OP_LOGIN,
            previous_values=None,
            # Só o nível de garantia da sessão. Nunca token/claims/e-mail/IP.
            new_values={"aal": aal} if isinstance(aal, str) and aal else None,
            request_id=get_request_id(),
            result=_AUDIT_RESULT,
        )
    )
    return True
