"""Exclusão de usuário: LÓGICA + ANONIMIZAÇÃO irreversível (Frente B).

Contrato autoritativo: `docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md`
§2 (`POST /api/v1/users/<uuid:user_id>/delete`). Rota fina em
`app/api/v1/users.py`; toda a regra vive aqui.

DESVIO APROVADO em relação ao item 4 daquela §2 (decisão do coordenador em
2026-10-28): no Supabase Auth a identidade é APAGADA (`delete_user`), não
banida com remoção de fatores MFA. Banir mantinha o e-mail ocupado no GoTrue e
`generate_invite_token_hash` recusa e-mail já cadastrado, ou seja: a pessoa
excluída nunca poderia ser reconvidada (502 no convite). Não reverter para
`ban_user` sem resolver esse ciclo. Nada disso muda o banco do PROJETO, onde a
exclusão continua LÓGICA e o `audit_logs` é preservado.

POR QUE NUNCA HÁ EXCLUSÃO FÍSICA (não é escolha da aplicação, é do banco):
    `users.id` é referenciado por 4 FKs RESTRICT
    (`asset_movements.requested_by`, `import_previews.requested_by`,
    `inventories.created_by`, `invites.invited_by`) e por
    `audit_logs.actor_user_id` com `ON DELETE SET NULL` — UPDATE que o
    gatilho `trg_audit_logs_block_update_delete` (migração 0004) RECUSA,
    porque `audit_logs` é APPEND-ONLY. Um `DELETE FROM users` falha, e é
    assim que tem de ser: a trilha de auditoria do excluído, inclusive o
    `actor_user_id` dele, é PRESERVADA e nunca é apagada, anonimizada nem
    reescrita. Nenhuma FK, gatilho ou RLS é removido para "viabilizar" DELETE.

O QUE A EXCLUSÃO FAZ (tudo em UMA transação, ver `delete_user`):
    1. `deleted_at`/`deleted_by`/`anonymized_at` preenchidos (0019).
    2. `active=false` e `sessions_revoked_at=now` (todo JWT já emitido passa
       a receber 401 em `require_auth`, que também recusa `deleted_at`
       preenchido).
    3. Anonimização SÓ em `users`: `name` -> rótulo fixo; `email` -> endereço
       único e NÃO ROTEÁVEL derivado do `id` (a coluna é `NOT NULL UNIQUE` e
       o e-mail ORIGINAL volta a ficar livre para um convite futuro);
       `phone` -> NULL; `avatar_object_key` -> NULL; `auth_user_id` -> NULL.
       É IRREVERSÍVEL: nenhuma cópia do dado removido é guardada em lugar
       algum — o `audit_logs` recebe apenas o e-mail MASCARADO.
    4. `user_roles` e `user_unit_access` removidos; convite PENDENTE vira
       REVOGADO (mesmos efeitos do `InviteService.revoke_access`, aqui na
       mesma transação da anonimização).
    5. Depois do COMMIT, melhor esforço: APAGAR a identidade no Supabase Auth
       (`delete_user`, que leva embora sessões, identidades e fatores MFA e
       LIBERA o e-mail para um convite futuro) e remover a foto do bucket
       privado. Falha de provedor/storage NÃO desfaz a exclusão local — é
       registrada e segue (igual a `revoke_access`/`deactivate`). Note que o
       que é apagado é só a identidade no provedor: no banco do projeto a
       linha de `users` e todo o `audit_logs` continuam preservados.

POR QUE NÃO CHAMAMOS `revoke_access` DIRETAMENTE: aquele serviço faz
`commit()` no meio do fluxo e depois fala com o Supabase. Chamá-lo aqui
quebraria o requisito de UMA transação (haveria uma janela com a conta
revogada e ainda NÃO anonimizada) e repetiria consultas de escopo já feitas.
Esta classe herda `UserAdminService` e reaproveita, sem duplicar,
TODAS as guardas e helpers já auditados: `_lock_admin_mutations` (advisory
lock global do "último ADM", tomado ANTES de qualquer leitura do alvo — sem
TOCTOU), `_revalidate_actor`, `_load_scoped_target` (404 único para alvo
inexistente/alheio/malformado), `_check_version`, `_require_full_scope`,
`_ensure_not_last_admin`, `_supersede_pending_invites`, `_bump_version` e
`_audit`.

GUARDAS: ADM + AAL2 + permissão dedicada `users.delete` (na rota),
autoexclusão BLOQUEADA, último ADM ativo protegido, `version` (controle
otimista), `confirm_text` = e-mail exato do alvo e limite de tentativas por
ator (rota) e por alvo (`consume_target_quota`, consumido só DEPOIS de
confirmar o escopo — UA-RL-01).

CONTA SEM UNIDADE (órfã, ex.: acesso já revogado): pode ser excluída. É o
caso de uso principal ("revogar e depois excluir") e uma conta órfã não tem
papel, unidade nem acesso operacional algum. Para alvo ADM continua valendo
o escopo TOTAL (UA-SCOPE-01).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import delete

from app.integrations.supabase_admin_client import SupabaseAdminClientError
from app.integrations.supabase_storage_client import (
    StorageUnavailableError,
    is_valid_object_key,
)
from app.models.rbac import User, UserRole
from app.models.units import UserUnitAccess
from app.services.user_admin_service import (
    ADM,
    MutationResult,
    SelfChangeForbiddenError,
    UserAdminError,
    UserAdminService,
    _utcnow,
    iso_utc,
    primary_role,
)

logger = logging.getLogger(__name__)

OP_DELETED = "USER_DELETED"

# Rótulo fixo exibido onde a conta ainda aparece (histórico/movimentações
# antigas). Nunca contém dado pessoal.
ANONYMIZED_NAME = "Usuário excluído"

# Domínio reservado pela RFC 2606 (`.invalid` nunca resolve): o endereço
# anonimizado é único (derivado do `id`, que é a PK) e não roteável.
_ANONYMIZED_EMAIL_DOMAIN = "anonimizado.invalid"
_ANONYMIZED_EMAIL_PREFIX = "excluido+"

_MAX_CONFIRM_TEXT = 320


class ConfirmationMismatchError(UserAdminError):
    status_code = 400
    code = "confirmation_mismatch"
    message = (
        "Confirmação inválida: digite exatamente o e-mail do usuário para "
        "confirmar a exclusão."
    )


def anonymized_email(user_id: Any) -> str:
    """Endereço único e não roteável do usuário excluído (`NOT NULL UNIQUE`).

    Derivado do `id` (PK): nunca colide e nunca é igual ao e-mail original —
    por isso o e-mail ORIGINAL volta a estar livre para um convite futuro.
    """
    return f"{_ANONYMIZED_EMAIL_PREFIX}{user_id}@{_ANONYMIZED_EMAIL_DOMAIN}"


def is_anonymized_email(email: str | None) -> bool:
    return bool(email) and str(email).endswith(f"@{_ANONYMIZED_EMAIL_DOMAIN}")


def mask_email(email: str | None) -> str:
    """`ana.silva@agu.gov.br` -> `a***@a***.br` (auditoria sem dado pessoal).

    Mascara SEMPRE: o `audit_logs` da exclusão não pode guardar uma cópia do
    e-mail removido (a anonimização é irreversível). Valor inesperado ->
    `"***"`.
    """
    value = (email or "").strip()
    if "@" not in value or len(value) > _MAX_CONFIRM_TEXT:
        return "***"
    local, _, domain = value.partition("@")
    if not local or not domain:
        return "***"
    tail = domain.rsplit(".", 1)[-1] if "." in domain else ""
    masked_domain = f"{domain[0]}***.{tail}" if tail else f"{domain[0]}***"
    return f"{local[0]}***@{masked_domain}"


def _normalize_confirmation(value: str | None) -> str:
    return (value or "").strip().lower()


def confirmation_matches(confirm_text: str | None, email: str | None) -> bool:
    """True se `confirm_text` é o e-mail do alvo (ignora caixa e espaços)."""
    typed = _normalize_confirmation(confirm_text)
    expected = _normalize_confirmation(email)
    return bool(expected) and len(typed) <= _MAX_CONFIRM_TEXT and typed == expected


class UserDeletionService(UserAdminService):
    """`POST /users/<id>/delete`: exclusão lógica + anonimização irreversível."""

    def delete_user(
        self,
        actor_id: Any,
        target_id: uuid.UUID,
        *,
        version: int,
        confirm_text: str | None,
        consume_target_quota: Callable[[], None] | None = None,
    ) -> MutationResult:
        """Exclui logicamente e anonimiza o alvo. Ver a docstring do módulo.

        Erros (todos do contrato de `UserAdminError`): 404 `not_found` (alvo
        inexistente, alheio, malformado ou JÁ excluído — resposta idêntica),
        409 `self_change_forbidden`, 409 `version_conflict`, 409 `last_admin`,
        400 `confirmation_mismatch`, 403 `target_out_of_scope`/`forbidden`,
        429/503 do limite por alvo.
        """
        if target_id == actor_id:
            # Autoexclusão BLOQUEADA (o ADM não se tranca fora do sistema e
            # a separação "quem exclui" x "quem é excluído" é preservada).
            raise SelfChangeForbiddenError()
        # Lock global ANTES de qualquer leitura do alvo: mesma ordem do
        # `revoke_access`/`deactivate` (lock global -> linha), sem TOCTOU na
        # proteção do último ADM e sem ciclo de espera.
        self._lock_admin_mutations()
        self._revalidate_actor(actor_id)
        target, actor_units = self._load_scoped_target(actor_id, target_id, for_update=True)
        # Cota por ALVO só depois do escopo (UA-RL-01): um ADM de outra
        # unidade não esgota o limite da vítima.
        if consume_target_quota is not None:
            consume_target_quota()
        self._check_version(target, version)
        if not confirmation_matches(confirm_text, target.email):
            raise ConfirmationMismatchError()

        role_codes = self._active_role_codes(target.id)
        if ADM in role_codes:
            # Excluir um ADM exige escopo TOTAL sobre as unidades dele
            # (UA-SCOPE-01) e nunca pode zerar os administradores ativos.
            self._require_full_scope(actor_units, "delete_admin")
            self._ensure_not_last_admin(target.id)

        now = _utcnow()
        auth_user_id = target.auth_user_id
        avatar_key = target.avatar_object_key
        was_active = bool(target.active)
        previous_role = primary_role(role_codes)
        # Mascarado ANTES da anonimização: o valor em claro nunca é gravado.
        masked_email = mask_email(target.email)

        # Revogação total (mesmos efeitos do `InviteService.revoke_access`),
        # aqui na MESMA transação da anonimização.
        self._db.execute(delete(UserRole).where(UserRole.user_id == target.id))
        self._db.execute(delete(UserUnitAccess).where(UserUnitAccess.user_id == target.id))
        # Usa o e-mail/`auth_user_id` AINDA originais (antes da anonimização).
        invite_revoked = self._supersede_pending_invites(target, actor_id, now)

        target.active = False
        if was_active:
            target.deactivated_at = now
            target.deactivated_by = actor_id
        target.sessions_revoked_at = now
        target.deleted_at = now
        target.deleted_by = actor_id
        target.anonymized_at = now
        # Anonimização IRREVERSÍVEL, só em `users`.
        target.name = ANONYMIZED_NAME
        target.email = anonymized_email(target.id)
        target.phone = None
        target.avatar_object_key = None
        target.auth_user_id = None
        # Dado COMPORTAMENTAL (quando a pessoa acessou o sistema): numa linha
        # anonimizada ele seria re-identificável cruzando com
        # `audit_logs.actor_user_id`, que é preservado de propósito. Como
        # `require_auth` passou a gravar `last_login_at`
        # (`app.services.login_tracking_service`), a anonimização também o
        # apaga. A trilha de `audit_logs` (append-only) não é tocada.
        target.last_login_at = None
        self._bump_version(target)
        self._db.add(target)

        # Chaves escolhidas para casarem com as allowlists de leitura
        # (`admin_audit_service.CHANGE_KEYS` e `HISTORY_CHANGE_KEYS`): `role`,
        # `roles`, `active`, `avatar`, `sessions_revoked_at` e `deleted` saem
        # pela API de auditoria; `email_masked` e as demais ficam SÓ na linha
        # do banco (nem o e-mail mascarado é devolvido por API).
        self._audit(
            OP_DELETED,
            actor_id,
            target.id,
            {
                "active": was_active,
                "role": previous_role,
                "roles": sorted(role_codes),
                "avatar": avatar_key is not None,
                "deleted": False,
            },
            {
                "active": False,
                "role": None,
                "avatar": False,
                "deleted": True,
                "sessions_revoked_at": iso_utc(now),
                "deleted_at": iso_utc(now),
                "anonymized": True,
                # Nunca o e-mail em claro (ver `mask_email`).
                "email_masked": masked_email,
                "unit_access_removed": True,
                "invite_revoked": invite_revoked,
            },
        )
        self._db.commit()

        # Depois do commit (melhor esforço): o bloqueio que vale para a API
        # (`deleted_at` + `active=false` + `sessions_revoked_at`) já está
        # gravado. Nada aqui pode desfazer a exclusão local.
        provider_synced = self._purge_auth_identity(auth_user_id)
        avatar_purged = self._purge_avatar_object(avatar_key)

        summary = self._reload_summary(target.id, actor_units)
        summary["deleted_at"] = iso_utc(now)
        return MutationResult(
            summary=summary,
            changed=True,
            previous_role=previous_role,
            new_role=None,
            provider_synced=provider_synced,
            extra={"avatar_purged": avatar_purged, "invite_revoked": invite_revoked},
        )

    # -- efeitos externos (pós-commit, melhor esforço) -------------------------

    def _purge_auth_identity(self, auth_user_id: str | None) -> bool:
        """APAGA a identidade do usuário no Supabase Auth (melhor esforço).

        `SupabaseAdminClient.delete_user` (`DELETE /auth/v1/admin/users/{id}`)
        em vez de banir: o GoTrue mantém o e-mail OCUPADO enquanto a conta
        existir, mesmo banida, e `generate_invite_token_hash` recusa e-mail já
        cadastrado — sem o DELETE, quem fosse excluído nunca poderia ser
        reconvidado com o mesmo endereço (502 no convite). Apagar a linha do
        GoTrue também destrói, de uma vez, sessões, refresh tokens,
        identidades e fatores MFA do usuário, então não é preciso chamar
        `delete_all_mfa_factors` antes.

        O que vale para ESTA API nunca dependeu do provedor: `deleted_at` +
        `active=false` + `sessions_revoked_at` já estão gravados e
        `require_auth` responde 401. Por isso aqui NUNCA se levanta exceção —
        a exclusão local não é desfeita por falha do Supabase; a falha é
        registrada (sem dado pessoal) e `provider_synced=False` faz a rota
        emitir `USER_PROVIDER_SYNC_FAILED`.

        No banco do PROJETO nada é apagado: a linha de `users` e todo o
        `audit_logs` (inclusive `actor_user_id` do excluído) permanecem.
        """
        if not auth_user_id:
            return True
        if self._admin_client is None:
            logger.error(
                "user_deletion_service: cliente do Supabase Auth ausente; conta já "
                "excluída e anonimizada localmente (identidade no provedor não removida)."
            )
            return False
        try:
            self._admin_client.delete_user(auth_user_id)
        except SupabaseAdminClientError as exc:
            logger.error(
                "user_deletion_service: remoção da identidade no Supabase Auth falhou "
                "(%s); conta já excluída e anonimizada localmente. O e-mail segue "
                "ocupado no provedor até a remoção manual.",
                exc.__class__.__name__,
            )
            return False
        return True

    def _purge_avatar_object(self, object_key: str | None) -> bool:
        """Apaga a foto do bucket privado. Nunca levanta (objeto órfão é
        aceitável; a chave já saiu do banco)."""
        if not object_key:
            return True
        if not is_valid_object_key(object_key):
            return False
        storage = self._storage
        if storage is None:
            logger.warning("user_deletion_service: storage ausente; foto não removida (órfã).")
            return False
        try:
            storage.delete(object_key)
        except StorageUnavailableError:
            logger.warning(
                "user_deletion_service: foto não removida do Storage (órfã); conta já "
                "excluída e anonimizada."
            )
            return False
        return True


def is_deleted(user: User | None) -> bool:
    """True se o usuário está logicamente excluído (nunca autentica: 401)."""
    if user is None:
        return False
    deleted_at = getattr(user, "deleted_at", None)
    return isinstance(deleted_at, datetime)


__all__ = [
    "ANONYMIZED_NAME",
    "ConfirmationMismatchError",
    "OP_DELETED",
    "UserDeletionService",
    "anonymized_email",
    "confirmation_matches",
    "is_anonymized_email",
    "is_deleted",
    "mask_email",
]
