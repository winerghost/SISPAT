"""Entrega do e-mail de CONVITE de acesso PELO PRÓPRIO BACKEND.

Por que este módulo existe (ver
`docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md` §1): o e-mail de
convite do Supabase (`POST /auth/v1/invite`) usa o template do painel, cujo
`{{ .ConfirmationURL }}` é um GET de USO ÚNICO em `/auth/v1/verify`. Os logs
do projeto (2026-10-27, 18:54:43) provaram que scanners de antivírus de
e-mail abrem esse link 2–4 s após o envio: gastam o token (a pessoa vê "link
expirado") e, por ser fluxo implícito, recebem access/refresh token válidos
da conta. É o MESMO defeito já corrigido no reset de senha
(`app.services.password_reset_delivery`), cuja correção está validada em
produção desde 2026-10-28.

Fluxo: `admin/generate_link` (type=invite, NÃO envia e-mail) cria o usuário
no Auth e devolve `id` + `hashed_token`; montamos
`<redirect_to>?token_hash=...&type=invite`, que aponta para a nossa página
`/ativar-conta` — um GET de scanner apenas CARREGA a página, que só chama
`verifyOtp` depois do clique da pessoa.

Por que um módulo IRMÃO de `password_reset_delivery` e não a generalização
dele: aquele módulo está em produção com a correção validada, e os testes de
segurança já existentes (`test_password_reset_delivery`, `test_sec_user_admin`,
`test_user_admin_api`) substituem `password_reset_delivery.send_email_safely`
por um dublê — delegar o envio para um núcleo compartilhado silenciaria
aqueles dublês (o reset passaria a tentar SMTP de verdade nos testes) sem
quebrar nenhuma asserção de assinatura. Além disso os dois fluxos divergem no
essencial: o convite precisa devolver TAMBÉM o `auth_user_id` criado no Auth,
usa outro `type`, outro template e outro `purpose` de auditoria. O que é
comum são 3 linhas de montagem de URL; o vocabulário de resultados é mantido
idêntico de propósito (há teste de paridade em `test_invite_delivery`).

Garantias de segurança deste módulo (as mesmas do reset):
    - O `token_hash` e a URL montada NUNCA são logados, auditados, devolvidos
      ao chamador nem incluídos em exceção. Só existem em memória, dentro de
      `deliver_invite`, e seguem apenas para o corpo do e-mail. O retorno
      carrega o `auth_user_id` e um código curto de resultado — nunca o token.
    - A URL é validada por `validate_link` contra a allow-list
      (`INVITE_ALLOWED_REDIRECT_URLS`) antes de entrar no template: nem o
      esquema, nem o host, nem o caminho podem divergir do autorizado.
    - `quote(safe="")` no token impede injeção de separadores (`&`, `#`, `?`)
      e troca do `type` do link.
    - O envio usa `send_email_safely`, que nunca levanta, aplica o teto
      `EMAIL_MAX_PER_HOUR` (fail-closed) e audita com o destinatário
      mascarado e sem corpo.
    - O código de resultado é pensado para ir ao `audit_logs`/log sem revelar
      nada: nunca contém e-mail, link ou token.

Consequência operacional: se o e-mail não sair, o usuário JÁ existe no
Supabase Auth (o `generate_link` o cria). `invite_service.create_invite`
trata isso como falha do convite e NÃO cria nada localmente, para nunca
reportar sucesso sem entrega; uma nova tentativa com o mesmo e-mail reaproveita
o usuário convidado ainda não confirmado — mesma limitação (sem SAGA) já
documentada na docstring de `app.services.invite_service`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote, urlsplit

from app.config.settings import Settings, get_settings
from app.integrations.supabase_admin_client import GeneratedInvite
from app.services.email.dispatch import send_email_safely
from app.services.email.sender import (
    STATUS_DISABLED,
    STATUS_SENT,
    EmailMessageData,
)
from app.services.email.templates import TemplateError, render_email

PURPOSE = "invite"

# Mesmo vocabulário de `password_reset_delivery` (paridade garantida por
# teste): os códigos vão para log/auditoria e não revelam nada.
OUTCOME_SENT = "sent"
OUTCOME_EMAIL_DISABLED = "email_disabled"
OUTCOME_EMAIL_FAILED = "email_failed"
OUTCOME_LINK_NOT_ALLOWED = "link_not_allowed"


class _InviteTokenSource(Protocol):
    def generate_invite_token_hash(
        self, email: str, name: str, redirect_to: str
    ) -> GeneratedInvite: ...


@dataclass(frozen=True)
class InviteDelivery:
    """Resultado da entrega. NUNCA carrega o token nem a URL do convite."""

    auth_user_id: str
    outcome: str


def build_invite_url(redirect_to: str, token_hash: str) -> str:
    """Monta `<redirect_to>?token_hash=<hash>&type=invite`.

    `quote(safe="")` impede que um `hashed_token` inesperado injete separadores
    (`&`, `#`, `?`) e acrescente parâmetros ao link enviado — inclusive um
    `&type=recovery`, que levaria o convidado para a tela errada.
    """
    separator = "&" if urlsplit(redirect_to).query else "?"
    return f"{redirect_to}{separator}token_hash={quote(token_hash, safe='')}&type=invite"


def deliver_invite(
    *,
    token_source: _InviteTokenSource,
    email: str,
    recipient_name: str,
    redirect_to: str,
    settings: Settings | None = None,
) -> InviteDelivery:
    """Cria o convite no Auth, monta o link e envia o e-mail.

    Devolve o `auth_user_id` criado no Supabase Auth e o código do resultado
    do envio (`OUTCOME_*`) — nunca o token nem a URL.

    Propaga `SupabaseAdminClientError` / `InviteRedirectNotAllowedError` do
    `token_source` para o chamador decidir o erro de domínio — este módulo não
    os converte, para não mascarar falha de provedor.
    """
    s = settings or get_settings()
    generated = token_source.generate_invite_token_hash(email, recipient_name, redirect_to)
    action_url = build_invite_url(redirect_to, generated.token_hash)
    try:
        rendered = render_email(
            "invite",
            {"recipient_name": recipient_name, "action_url": action_url},
            allowed_links=s.invite_allowed_redirect_urls_list,
        )
    except TemplateError:
        # Nunca repassar a URL nem o motivo detalhado: o link é segredo.
        return InviteDelivery(generated.auth_user_id, OUTCOME_LINK_NOT_ALLOWED)
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
        return InviteDelivery(generated.auth_user_id, OUTCOME_SENT)
    if result.status == STATUS_DISABLED:
        return InviteDelivery(generated.auth_user_id, OUTCOME_EMAIL_DISABLED)
    return InviteDelivery(generated.auth_user_id, OUTCOME_EMAIL_FAILED)
