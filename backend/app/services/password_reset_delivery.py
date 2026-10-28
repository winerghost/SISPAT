"""Entrega do e-mail de redefinição de senha PELO PRÓPRIO BACKEND.

Por que este módulo existe (ver
`docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md`): o e-mail de recuperação
do Supabase usa o template do painel, cujo `{{ .ConfirmationURL }}` é um GET
de USO ÚNICO em `/auth/v1/verify`. Os logs do projeto (2026-10-27) provaram
que scanners de antivírus de e-mail abrem esse link 2–4 s após o envio:
gastam o token (a pessoa vê "link expirado") e, por ser fluxo implícito,
recebem access/refresh token válidos da conta. Corrigir pelo template exigiria
plano pago, então a entrega passou a ser nossa.

Fluxo: `admin/generate_link` (type=recovery, NÃO envia e-mail) devolve o
`hashed_token`; montamos `<redirect_to>?token_hash=...&type=recovery`, que
aponta para a nossa página — um GET de scanner apenas CARREGA a página, que só
chama `verifyOtp` depois do clique da pessoa.

Garantias de segurança deste módulo:
    - O `token_hash` e a URL montada NUNCA são logados, auditados, devolvidos
      ao chamador nem incluídos em exceção. Só existem em memória, dentro de
      `deliver_password_reset`, e seguem apenas para o corpo do e-mail.
    - A URL é validada por `validate_link` contra a allow-list
      (`INVITE_ALLOWED_REDIRECT_URLS`) antes de entrar no template: nem o
      esquema, nem o host, nem o caminho podem divergir do autorizado.
    - O envio usa `send_email_safely`, que nunca levanta, aplica o teto
      `EMAIL_MAX_PER_HOUR` (fail-closed) e audita com o destinatário
      mascarado e sem corpo.
    - O retorno é um código de resultado curto, pensado para ir ao
      `audit_logs` sem revelar nada: nunca contém e-mail, link ou token.
"""
from __future__ import annotations

from typing import Protocol
from urllib.parse import quote, urlsplit

from app.config.settings import Settings, get_settings
from app.services.email.dispatch import send_email_safely
from app.services.email.sender import (
    STATUS_DISABLED,
    STATUS_SENT,
    EmailMessageData,
)
from app.services.email.templates import TemplateError, render_email

PURPOSE = "password_reset"

OUTCOME_SENT = "sent"
OUTCOME_EMAIL_DISABLED = "email_disabled"
OUTCOME_EMAIL_FAILED = "email_failed"
OUTCOME_LINK_NOT_ALLOWED = "link_not_allowed"


class _RecoveryTokenSource(Protocol):
    def generate_recovery_token_hash(self, email: str, redirect_to: str) -> str: ...


def build_recovery_url(redirect_to: str, token_hash: str) -> str:
    """Monta `<redirect_to>?token_hash=<hash>&type=recovery`.

    `quote(safe="")` impede que um `hashed_token` inesperado injete separadores
    (`&`, `#`, `?`) e acrescente parâmetros ao link enviado.
    """
    separator = "&" if urlsplit(redirect_to).query else "?"
    return f"{redirect_to}{separator}token_hash={quote(token_hash, safe='')}&type=recovery"


def deliver_password_reset(
    *,
    token_source: _RecoveryTokenSource,
    email: str,
    recipient_name: str,
    redirect_to: str,
    settings: Settings | None = None,
) -> str:
    """Gera o token, monta o link e envia o e-mail. Devolve o código do resultado.

    Propaga `SupabaseAdminClientError` / `InviteRedirectNotAllowedError` do
    `token_source` para o chamador decidir o `reason` da auditoria — este
    módulo não os converte, para não mascarar falha de provedor.
    """
    s = settings or get_settings()
    token_hash = token_source.generate_recovery_token_hash(email, redirect_to)
    action_url = build_recovery_url(redirect_to, token_hash)
    try:
        rendered = render_email(
            "recovery",
            {"recipient_name": recipient_name, "action_url": action_url},
            allowed_links=s.invite_allowed_redirect_urls_list,
        )
    except TemplateError:
        # Nunca repassar a URL nem o motivo detalhado: o link é segredo.
        return OUTCOME_LINK_NOT_ALLOWED
    result = send_email_safely(
        EmailMessageData(
            to=email,
            subject=rendered.subject,
            text_body=rendered.text,
            html_body=rendered.html,
        ),
        purpose=PURPOSE,
        settings=s,
    )
    if result.status == STATUS_SENT:
        return OUTCOME_SENT
    if result.status == STATUS_DISABLED:
        return OUTCOME_EMAIL_DISABLED
    return OUTCOME_EMAIL_FAILED
