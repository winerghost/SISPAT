"""Serviço de convites de usuário (cadastro exclusivamente por convite).

Orquestra o fluxo administrativo de convite/ativação/revogação descrito em
`app.models.invites` (ver docstring daquele módulo para o contexto
completo), sempre em conjunto com o Supabase Auth
(`app.integrations.supabase_admin_client.SupabaseAdminClient`).

DECISÃO DE DESIGN CENTRAL (fixada, não revisar sem atualizar esta docstring):
    Quando um convite é criado, a chamada a
    `SupabaseAdminClient.invite_user_by_email(...)` retorna o `auth_user_id`
    do usuário recém-criado no Supabase Auth. Nesse exato momento -- ainda
    dentro de `create_invite` --, este serviço cria IMEDIATAMENTE a linha
    correspondente em `users` (`active=True`), SEM NENHUMA linha em
    `user_roles`/`user_unit_access` ainda.

    Isso é o que permite que `app.auth.supabase_auth.require_auth` funcione
    normalmente para esse usuário assim que ele definir a senha (ou seja, a
    partir do momento em que ele tiver uma sessão Supabase válida) -- mas,
    como ele não possui nenhum papel nem permissão até aceitar o convite
    (`activate_invite`), ele não consegue fazer ABSOLUTAMENTE NADA além de
    `GET /api/v1/me` (que só exige `require_auth`) e
    `POST /api/v1/users/activate-invite` (idem). Qualquer outra rota exige,
    no mínimo, uma permissão granular (`app.authorization.rbac.
    require_permission`), e um usuário sem nenhuma linha em `user_roles`
    tem, por definição, o conjunto de permissões vazio.

    Em outras palavras: "a atribuição de perfis e unidades ocorre em etapa
    controlada, sem conceder acesso operacional antes da ativação" é uma
    garantia do próprio modelo RBAC (zero papéis = zero permissões = zero
    acesso operacional), NÃO de uma flag especial em `users.active` -- essa
    coluna continua `True` desde a criação, exatamente como para qualquer
    outro usuário ativo do sistema. Não introduzir um estado "pendente" via
    `users.active=False` para este fluxo: isso quebraria `require_auth`
    (que rejeita usuários inativos) exatamente no momento em que o usuário
    convidado precisa conseguir chamar `GET /api/v1/me` e
    `POST /api/v1/users/activate-invite`.

Resolução da URL de ativação (`redirect_to`):
    `SupabaseAdminClient.invite_user_by_email` exige um `redirect_to` que já
    esteja na allow-list `settings.invite_allowed_redirect_urls_list` (ver
    `app.integrations.supabase_admin_client`). Este serviço não introduz uma
    nova variável de ambiente para "a" URL de ativação (fora do escopo desta
    tarefa alterar `Settings` além de `invite_ttl_days`) -- em vez disso,
    usa deliberadamente a PRIMEIRA URL dessa lista já existente como a URL de
    ativação configurada. Isso pressupõe que, em produção, essa lista
    contenha exatamente (ou liste primeiro) a URL da tela de ativação de
    convite do frontend. Se a lista estiver vazia, a configuração é tratada
    como ausente e `create_invite` levanta `InviteServiceError` (API: 502) --
    mesma família de erro usada para qualquer outra falha ao falar com o
    Supabase Auth, pois também é uma condição que impede completar o
    convite. Esta é uma suposição PENDENTE de confirmação operacional (no
    mesmo espírito de outras suposições já documentadas em
    `app.services.import_service`).

Gestão de transação:
    Segue o mesmo DESVIO INTENCIONAL já documentado em
    `app.services.import_service.ImportService`: este serviço RECEBE a
    sessão (`db_session`) já aberta pelo chamador (permite injeção de mocks
    nos testes) e gerencia explicitamente o `commit()` das suas mudanças de
    negócio. A camada de API (`app.api.v1.users`) abre a sessão via
    `with get_db_session() as db: ...`; o `commit()` adicional (sem nada
    pendente) feito por aquele `with` ao final é inofensivo (no-op).

    Limitação documentada: a chamada a `SupabaseAdminClient.invite_user_by_email`
    ocorre ANTES do commit da transação local. Se o commit local falhar
    depois que o Supabase já criou o usuário convidado, o usuário convidado
    existe no Supabase Auth sem uma linha local correspondente em `users`
    (até uma nova tentativa de convite, que a idempotência defensiva do
    passo 5 trata ao religar pelo mesmo e-mail/`auth_user_id`). Não há, nesta
    fase, uma transação distribuída/compensação automática entre o Supabase
    Auth e o Postgres local -- mesma limitação, em espírito, da ausência de
    SAGA documentada em outras integrações externas deste projeto.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from app.config.settings import Settings, get_settings
from app.integrations.supabase_admin_client import SupabaseAdminClient, SupabaseAdminClientError
from app.models.audit import AuditLog
from app.models.invites import Invite, InviteUnit
from app.models.rbac import Role, User, UserRole
from app.models.units import Unit, UserUnitAccess

logger = logging.getLogger(__name__)

# Únicos papéis atribuíveis pelo fluxo de convite direto. 'ADM' é
# DELIBERADAMENTE excluído -- ver docstring do módulo `app.models.invites`
# (atribuição de ADM é um processo administrativo separado e mais restrito,
# fora do escopo deste serviço, para reduzir o risco de escalonamento de
# privilégio via convite).
_INVITABLE_ROLE_CODES = ("USER", "RH")
_ADM_ROLE_CODE = "ADM"

# Chave fixa do advisory lock transacional do Postgres que serializa
# revogações (proteção do "último ADM" contra corrida TOCTOU: duas
# revogações concorrentes de ADMs distintos não podem, juntas, zerar os
# administradores do sistema).
_REVOKE_ADVISORY_LOCK_KEY = 0x5349_5350_4144_4D  # "SISPADM"

_PENDING_STATUS = "PENDENTE"
_ACCEPTED_STATUS = "ACEITO"
_EXPIRED_STATUS = "EXPIRADO"
_REVOKED_STATUS = "REVOGADO"


class InviteServiceError(Exception):
    """Erro de domínio base de `InviteService`.

    Levantada diretamente (não uma das subclasses abaixo) para falhas de
    infraestrutura/configuração -- ex.: falha ao chamar a API Admin do
    Supabase, ou ausência de URL de ativação configurada. A camada de API
    (`app.api.v1.users`) deve mapear esta exceção (quando não for nenhuma
    das subclasses mais específicas abaixo) para HTTP 502, com uma mensagem
    genérica -- nunca repassando o detalhe interno ao cliente.
    """


class InviteValidationError(InviteServiceError):
    """Dados de entrada inválidos (papel não permitido, unidades inexistentes
    ou inativas, lista de unidades vazia, etc.). A API deve mapear para
    HTTP 400."""


class InviteAlreadyPendingError(InviteServiceError):
    """Já existe um convite `PENDENTE` para este e-mail (case-insensitive).

    A API deve mapear para HTTP 409.
    """


class InviteNotFoundError(InviteServiceError):
    """Nenhum convite `PENDENTE` encontrado para o usuário atual.

    Cobre tanto a ausência total de convite quanto a tentativa de ativar um
    convite que já não está mais `PENDENTE` (já aceito, expirado ou
    revogado) -- ver docstring de `activate_invite` sobre a idempotência
    desta checagem. A API deve mapear para HTTP 404.
    """


class InviteExpiredError(InviteServiceError):
    """O convite encontrado já expirou (`now() > expires_at`) e foi marcado
    `EXPIRADO` nesta própria chamada -- NUNCA pode ser aceito.

    A API deve mapear para HTTP 409.
    """


class LastAdminError(InviteServiceError):
    """A revogação solicitada deixaria o sistema sem nenhum usuário com o
    papel `ADM` ativo -- bloqueada.

    A API deve mapear para HTTP 409.
    """


class UserNotFoundError(InviteServiceError):
    """Nenhum usuário local encontrado com o id informado.

    A API deve mapear para HTTP 404.
    """


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _user_advisory_lock_key(user_id: uuid.UUID) -> int:
    """Chave (bigint positivo) do advisory lock por usuário."""
    return uuid.UUID(str(user_id)).int & 0x7FFF_FFFF_FFFF_FFFF


def _acquire_advisory_xact_lock(db_session: Session, key: int) -> None:
    """`pg_advisory_xact_lock`: liberado automaticamente no commit/rollback."""
    db_session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


class InviteService:
    """Serviço de convites de usuário (criação, ativação, revogação).

    Ver docstring do módulo para a decisão de design central (criação
    imediata da linha em `users` sem papéis/unidades), a resolução da URL de
    ativação e a gestão de transação.
    """

    def __init__(
        self,
        db_session: Session,
        admin_client: SupabaseAdminClient,
        settings: Settings | None = None,
    ) -> None:
        self._db = db_session
        self._admin_client = admin_client
        self._settings = settings or get_settings()

    # ------------------------------------------------------------------
    # create_invite
    # ------------------------------------------------------------------

    def create_invite(
        self,
        invited_by_user_id: uuid.UUID,
        email: str,
        name: str,
        intended_role_code: str,
        unit_ids: list[uuid.UUID],
        justification: str | None = None,
    ) -> Invite:
        """Cria um convite de usuário. Ver docstring do módulo para o
        contexto completo. Passos (na ordem, cada um pode levantar um erro
        de domínio distinto):

            1. Valida `intended_role_code` (apenas 'USER'/'RH';
               `InviteValidationError` para qualquer outro valor, inclusive
               'ADM').
            2. Valida `email`/`name` não vazios e `unit_ids` não vazio, com
               todas as unidades existentes e `active=True`
               (`InviteValidationError`).
            3. Verifica convite `PENDENTE` já existente para o mesmo e-mail
               (case-insensitive) -- `InviteAlreadyPendingError` (API 409).
            4. Chama `SupabaseAdminClient.invite_user_by_email` com a URL de
               ativação configurada -- qualquer falha vira
               `InviteServiceError` (API 502).
            5. Em uma transação: cria `users` (idempotente por
               `auth_user_id`/e-mail), `Invite` (`PENDENTE`,
               `expires_at=now()+invite_ttl_days`), `InviteUnit`s e um
               `AuditLog` (`INVITE_CREATED`, SEM nenhum token/segredo).
            6. Retorna o `Invite` criado.
        """
        if intended_role_code not in _INVITABLE_ROLE_CODES:
            raise InviteValidationError(
                "intended_role_code deve ser 'USER' ou 'RH'; a atribuição do papel "
                "'ADM' não é permitida por este fluxo de convite."
            )

        if not isinstance(email, str) or not email.strip():
            raise InviteValidationError("O campo 'email' é obrigatório.")
        if not isinstance(name, str) or not name.strip():
            raise InviteValidationError("O campo 'name' é obrigatório.")

        if not unit_ids:
            raise InviteValidationError("O campo 'unit_ids' é obrigatório e não pode ser vazio.")

        unique_unit_ids = list(dict.fromkeys(unit_ids))  # preserva ordem, remove duplicatas
        units = self._db.query(Unit).filter(Unit.id.in_(unique_unit_ids)).all()
        units_by_id = {unit.id: unit for unit in units}

        missing_unit_ids = [uid for uid in unique_unit_ids if uid not in units_by_id]
        if missing_unit_ids:
            raise InviteValidationError(
                f"Unidade(s) inexistente(s): {', '.join(str(uid) for uid in missing_unit_ids)}."
            )

        inactive_unit_ids = [uid for uid in unique_unit_ids if not units_by_id[uid].active]
        if inactive_unit_ids:
            raise InviteValidationError(
                f"Unidade(s) inativa(s), não podem receber novos acessos: "
                f"{', '.join(str(uid) for uid in inactive_unit_ids)}."
            )

        normalized_email = _normalize_email(email)
        existing_pending = (
            self._db.query(Invite)
            .filter(
                func.lower(Invite.email) == normalized_email,
                Invite.status == _PENDING_STATUS,
            )
            .first()
        )
        if existing_pending is not None:
            raise InviteAlreadyPendingError(
                f"Já existe um convite pendente para o e-mail '{normalized_email}'."
            )

        allowed_redirect_urls = self._settings.invite_allowed_redirect_urls_list
        if not allowed_redirect_urls:
            logger.error(
                "invite_service.create_invite: nenhuma URL de ativação configurada "
                "(invite_allowed_redirect_urls_list vazia)."
            )
            raise InviteServiceError(
                "Não foi possível enviar o convite: nenhuma URL de ativação configurada."
            )
        activation_redirect_to = allowed_redirect_urls[0]

        email_clean = email.strip()
        name_clean = name.strip()

        try:
            response = self._admin_client.invite_user_by_email(
                email_clean, name_clean, redirect_to=activation_redirect_to
            )
        except SupabaseAdminClientError as exc:
            logger.error(
                "invite_service.create_invite: falha ao convidar usuário via API Admin "
                "do Supabase (%s).",
                exc.__class__.__name__,
            )
            raise InviteServiceError(
                "Não foi possível enviar o convite no momento."
            ) from exc

        invited_auth_user_id = response.get("id")
        if not invited_auth_user_id:
            logger.error(
                "invite_service.create_invite: resposta da API Admin do Supabase sem "
                "'id' do usuário convidado."
            )
            raise InviteServiceError(
                "Resposta inesperada do provedor de autenticação ao convidar o usuário."
            )

        now = datetime.now(timezone.utc)
        ttl_days = getattr(self._settings, "invite_ttl_days", 7) or 7
        expires_at = now + timedelta(days=ttl_days)

        # Idempotência defensiva: pode já existir uma linha em `users` com
        # este `auth_user_id` ou e-mail (ex.: convite anterior cuja chamada
        # ao Supabase teve sucesso mas cujo commit local falhou -- ver
        # docstring do módulo). Nunca cria uma segunda linha duplicada.
        local_user = (
            self._db.query(User)
            .filter(
                or_(
                    User.auth_user_id == invited_auth_user_id,
                    func.lower(User.email) == normalized_email,
                )
            )
            .first()
        )
        if local_user is None:
            local_user = User(
                id=uuid4(),
                auth_user_id=invited_auth_user_id,
                name=name_clean,
                email=email_clean,
                active=True,
            )
            self._db.add(local_user)
            self._db.flush()
        elif not local_user.auth_user_id:
            local_user.auth_user_id = invited_auth_user_id
            self._db.add(local_user)

        invite = Invite(
            id=uuid4(),
            email=email_clean,
            name=name_clean,
            intended_role_code=intended_role_code,
            justification=justification,
            status=_PENDING_STATUS,
            invited_by=invited_by_user_id,
            invited_auth_user_id=invited_auth_user_id,
            created_at=now,
            expires_at=expires_at,
        )
        self._db.add(invite)
        self._db.flush()

        invite_units = [
            InviteUnit(id=uuid4(), invite_id=invite.id, unit_id=unit_id)
            for unit_id in unique_unit_ids
        ]
        if invite_units:
            self._db.add_all(invite_units)

        self._db.add(
            AuditLog(
                id=uuid4(),
                actor_user_id=invited_by_user_id,
                entity_type="invite",
                entity_id=str(invite.id),
                operation="INVITE_CREATED",
                previous_values=None,
                new_values={
                    "email": email_clean,
                    "intended_role_code": intended_role_code,
                    "unit_ids": [str(uid) for uid in unique_unit_ids],
                },
                result="SUCESSO",
            )
        )

        self._db.commit()
        return invite

    # ------------------------------------------------------------------
    # activate_invite
    # ------------------------------------------------------------------

    def activate_invite(self, current_user_id: uuid.UUID) -> dict[str, Any]:
        """Aceita o convite pendente do usuário atual, concedendo papel e
        unidades. Passos:

            1. Busca o `Invite` `PENDENTE` correspondente, preferindo
               `invited_auth_user_id == users.auth_user_id`; usa o e-mail do
               usuário atual como fallback. `InviteNotFoundError` (API 404)
               se nenhum convite `PENDENTE` for encontrado -- isto também é
               o mecanismo de IDEMPOTÊNCIA desta operação: uma segunda
               chamada encontra `status != 'PENDENTE'` (já `ACEITO` pela
               primeira chamada) e cai neste mesmo caminho, SEM duplicar
               papéis/unidades.
            2. Se `now() > expires_at`: marca `EXPIRADO`, confirma
               (`commit()`) essa transição imediatamente (precisa
               sobreviver mesmo que esta chamada falhe) e levanta
               `InviteExpiredError` (API 409) -- convite expirado NUNCA pode
               ser aceito.
            3. Em uma transação: cria `UserRole` (papel `intended_role_code`)
               e um `UserUnitAccess` por `InviteUnit`; marca
               `status='ACEITO'`, `accepted_at=now()`; cria `AuditLog`
               (`INVITE_ACCEPTED`).
            4. Retorna `{"role": intended_role_code, "units": [...]}`
               (`units` como lista de strings de `unit_id`).
        """
        user = self._db.query(User).filter(User.id == current_user_id).first()
        if user is None:
            # Defensivo: não deveria ocorrer para um usuário que acabou de
            # ser autenticado por `require_auth`, mas tratado da mesma forma
            # que "nenhum convite encontrado" (não há nada a ativar).
            raise InviteNotFoundError("usuário atual não encontrado")

        # Serializa ativações concorrentes do MESMO usuário: a segunda
        # chamada só lê o convite depois que a primeira confirmou (e então
        # já o encontra `ACEITO` -> InviteNotFoundError), evitando corrida
        # de reuso do convite.
        _acquire_advisory_xact_lock(self._db, _user_advisory_lock_key(user.id))

        invite = None
        if user.auth_user_id:
            invite = (
                self._db.query(Invite)
                .filter(
                    Invite.status == _PENDING_STATUS,
                    Invite.invited_auth_user_id == user.auth_user_id,
                )
                .first()
            )
        if invite is None:
            normalized_email = _normalize_email(user.email or "")
            invite = (
                self._db.query(Invite)
                .filter(
                    Invite.status == _PENDING_STATUS,
                    func.lower(Invite.email) == normalized_email,
                )
                .first()
            )
        if invite is None:
            raise InviteNotFoundError("nenhum convite pendente encontrado para este usuário")

        # Defesa em profundidade: um convite localizado pelo fallback de
        # e-mail, mas emitido para OUTRA identidade do Supabase Auth, não
        # pode ser aceito por esta sessão.
        if (
            invite.invited_auth_user_id
            and user.auth_user_id
            and invite.invited_auth_user_id != user.auth_user_id
        ):
            logger.warning(
                "invite_service.activate_invite: convite %s pertence a outra identidade "
                "do provedor de autenticação; ativação negada.",
                invite.id,
            )
            raise InviteNotFoundError("nenhum convite pendente encontrado para este usuário")

        # Defesa em profundidade: mesmo que uma linha de `invites` tenha sido
        # adulterada no banco, a ativação NUNCA concede papel fora de USER/RH.
        if invite.intended_role_code not in _INVITABLE_ROLE_CODES:
            logger.error(
                "invite_service.activate_invite: convite %s com papel não convidável; "
                "ativação negada.",
                invite.id,
            )
            raise InviteServiceError(
                "Não foi possível concluir a ativação do convite no momento."
            )

        now = datetime.now(timezone.utc)
        if now > invite.expires_at:
            invite.status = _EXPIRED_STATUS
            self._db.add(invite)
            # Precisa sobreviver mesmo que a ativação como um todo falhe
            # (mesmo espírito de `ImportService.confirm_preview`).
            self._db.commit()
            raise InviteExpiredError("este convite expirou e não pode mais ser aceito")

        role = self._db.query(Role).filter(Role.code == invite.intended_role_code).first()
        if role is None:
            logger.error(
                "invite_service.activate_invite: papel '%s' do convite %s não existe "
                "mais na tabela 'roles'.",
                invite.intended_role_code,
                invite.id,
            )
            raise InviteServiceError(
                "Não foi possível concluir a ativação do convite no momento."
            )

        self._db.add(
            UserRole(
                id=uuid4(),
                user_id=user.id,
                role_id=role.id,
                assigned_at=now,
                assigned_by=invite.invited_by,
            )
        )

        invite_units = (
            self._db.query(InviteUnit).filter(InviteUnit.invite_id == invite.id).all()
        )
        unit_ids = [iu.unit_id for iu in invite_units]
        for unit_id in unit_ids:
            self._db.add(
                UserUnitAccess(
                    id=uuid4(),
                    user_id=user.id,
                    unit_id=unit_id,
                    created_at=now,
                    created_by=invite.invited_by,
                )
            )

        invite.status = _ACCEPTED_STATUS
        invite.accepted_at = now
        self._db.add(invite)

        self._db.add(
            AuditLog(
                id=uuid4(),
                actor_user_id=user.id,
                entity_type="invite",
                entity_id=str(invite.id),
                operation="INVITE_ACCEPTED",
                previous_values={"status": _PENDING_STATUS},
                new_values={
                    "status": _ACCEPTED_STATUS,
                    "role": role.code,
                    "unit_ids": [str(uid) for uid in unit_ids],
                },
                result="SUCESSO",
            )
        )

        self._db.commit()

        return {"role": role.code, "units": [str(uid) for uid in unit_ids]}

    # ------------------------------------------------------------------
    # revoke_access
    # ------------------------------------------------------------------

    def revoke_access(
        self,
        target_user_id: uuid.UUID,
        revoked_by_user_id: uuid.UUID,
        reason: str | None = None,
    ) -> None:
        """Revoga IMEDIATAMENTE todo acesso operacional de `target_user_id`.

        Passos:
            1. `UserNotFoundError` (API 404) se `target_user_id` não existir.
            2. Proteção do último ADM: conta quantos usuários distintos têm
               atualmente o papel `ADM` ativo; se `target_user_id` for um
               deles e for o ÚNICO, levanta `LastAdminError` (API 409) e NÃO
               revoga nada -- aplica-se independentemente de quem está
               chamando (inclusive o próprio usuário, que nunca pode se
               autorrevogar se isso zerar os administradores do sistema).
            3. Remove (DELETE) todas as linhas de `UserRole` e de
               `UserUnitAccess` do usuário alvo -- revogação imediata de todo
               acesso operacional. A linha em `users` NUNCA é removida
               (preserva histórico/auditoria). Revogações são serializadas
               por advisory lock transacional (corrida do último ADM).
            4. Se havia um `Invite` ainda `PENDENTE` para esse usuário,
               marca `REVOGADO`, `revoked_at`/`revoked_by`.
            5. Desativa a conta (Etapa 2, achado A4): `active=false`,
               `deactivated_at/by` (se estava ativa), `sessions_revoked_at=now`
               (JWTs já emitidos passam a receber 401 em `require_auth`) e
               incrementa `users.version`.
            6. Cria `AuditLog` (`REVOKE_ACCESS`, incluindo `reason` se
               fornecido) e confirma (`commit()`) tudo.
            7. Depois do commit, bane o usuário no Supabase Auth (melhor
               esforço: falha só é logada; o bloqueio da API já vale).
        """
        target_user = self._db.query(User).filter(User.id == target_user_id).first()
        if target_user is None:
            raise UserNotFoundError(f"usuário {target_user_id} não encontrado")

        # Serializa revogações (ver `_REVOKE_ADVISORY_LOCK_KEY`) antes da
        # contagem de ADMs, eliminando a janela TOCTOU.
        _acquire_advisory_xact_lock(self._db, _REVOKE_ADVISORY_LOCK_KEY)

        adm_role = (
            self._db.query(Role)
            .filter(Role.code == _ADM_ROLE_CODE, Role.active.is_(True))
            .first()
        )
        if adm_role is not None:
            adm_user_ids = {
                user_role.user_id
                for user_role in self._db.query(UserRole)
                # Só ADMs com usuário ATIVO contam: um ADM desativado não
                # mantém o sistema administrável (ver LastAdminError).
                .filter(
                    UserRole.role_id == adm_role.id,
                    UserRole.user_id.in_(select(User.id).where(User.active.is_(True))),
                )
                .all()
            }
            if target_user_id in adm_user_ids and len(adm_user_ids) <= 1:
                raise LastAdminError(
                    "não é possível revogar o acesso do último administrador (ADM) "
                    "ativo do sistema."
                )

        user_roles = (
            self._db.query(UserRole).filter(UserRole.user_id == target_user_id).all()
        )
        previous_role_codes = sorted(
            {ur.role.code for ur in user_roles if ur.role is not None}
        )
        for user_role in user_roles:
            self._db.delete(user_role)

        # Remove também os vínculos de unidade: sem isso, um usuário
        # revogado e depois reconvidado para a unidade A recuperaria
        # silenciosamente o acesso antigo à unidade B (e a ativação falharia
        # por violação de unicidade se o novo convite repetisse a unidade).
        self._db.execute(
            delete(UserUnitAccess).where(UserUnitAccess.user_id == target_user_id)
        )

        normalized_email = _normalize_email(target_user.email or "")
        auth_or_email_filters = [func.lower(Invite.email) == normalized_email]
        if target_user.auth_user_id:
            auth_or_email_filters.append(Invite.invited_auth_user_id == target_user.auth_user_id)
        pending_invite = (
            self._db.query(Invite)
            .filter(Invite.status == _PENDING_STATUS, or_(*auth_or_email_filters))
            .first()
        )
        now = datetime.now(timezone.utc)
        if pending_invite is not None:
            pending_invite.status = _REVOKED_STATUS
            pending_invite.revoked_at = now
            pending_invite.revoked_by = revoked_by_user_id
            self._db.add(pending_invite)

        was_active = bool(target_user.active)
        target_user.active = False
        if was_active:
            target_user.deactivated_at = now
            target_user.deactivated_by = revoked_by_user_id
        target_user.sessions_revoked_at = now
        target_user.version = int(target_user.version or 1) + 1
        self._db.add(target_user)

        revoked_at_iso = now.isoformat(timespec="seconds").replace("+00:00", "Z")
        new_values: dict[str, Any] = {
            "previous_roles": previous_role_codes,
            "unit_access_removed": True,
            "active": False,
            "sessions_revoked_at": revoked_at_iso,
        }
        if reason:
            new_values["reason"] = reason

        self._db.add(
            AuditLog(
                id=uuid4(),
                actor_user_id=revoked_by_user_id,
                entity_type="user",
                entity_id=str(target_user_id),
                operation="REVOKE_ACCESS",
                previous_values={"roles": previous_role_codes, "active": was_active},
                new_values=new_values,
                result="SUCESSO",
            )
        )

        self._db.commit()

        if target_user.auth_user_id:
            try:
                self._admin_client.deactivate_user(target_user.auth_user_id)
            except SupabaseAdminClientError as exc:
                logger.error(
                    "invite_service.revoke_access: ban no Supabase falhou (%s); acesso já "
                    "revogado e conta desativada localmente.",
                    exc.__class__.__name__,
                )
