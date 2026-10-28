"""Cliente HTTP para a API Admin do Supabase Auth (GoTrue).

Este módulo fala com a API Admin do Supabase Auth usando a Service Role
Key — uma credencial de altíssimo privilégio que NUNCA deve sair do
backend (nunca exposta ao frontend, nunca incluída em nenhuma mensagem de
log, em nenhuma circunstância). O Supabase Auth gerencia os segredos de
MFA (TOTP) e o ciclo de vida do convite; este backend NUNCA vê nem
armazena esses segredos — apenas orquestra chamadas administrativas.

Operações suportadas (todas sobre `{settings.supabase_url}/auth/v1/...`):
    - `invite_user_by_email`: convida um novo usuário por e-mail
      (`POST /auth/v1/invite`).
    - `list_mfa_factors`: lista os fatores MFA cadastrados de um usuário
      (lidos do payload de `GET /auth/v1/admin/users/{id}`), usada tanto
      pelo fluxo de autorremoção (`app.api.v1.security`) quanto por um
      futuro procedimento de recuperação administrativa assistida.
    - `delete_mfa_factor`: remove um fator MFA específico de um usuário
      (procedimento de recuperação administrativa).
    - `deactivate_user` / `ban_user`: desativa/revoga o acesso de um usuário
      (bane o usuário no GoTrue); `unban_user` desfaz o banimento.
    - `send_password_recovery`: dispara o e-mail de recuperação de senha
      enviado PELO PRÓPRIO Supabase (`POST /auth/v1/recover`); o link nunca
      passa por este backend. NÃO é mais usado pelo fluxo de redefinição —
      ver o aviso na docstring do método.
    - `generate_recovery_token_hash`: cria o token de recuperação SEM enviar
      e-mail (`POST /auth/v1/admin/generate_link`) para que a entrega seja
      feita por `app.services.password_reset_delivery`. É o caminho em uso.
    - `delete_all_mfa_factors`: remove todos os fatores MFA de um usuário
      (reset administrativo de MFA).

Diferença deliberada em relação a `app.integrations.n8n_client`:
    O `N8nClient` nunca propaga exceções por padrão, pois webhooks de
    automação não podem derrubar uma operação patrimonial. Este cliente é
    o OPOSTO: todas as operações aqui são administrativas e críticas
    (convidar usuário, remover fator MFA, desativar acesso) — qualquer
    falha de rede/HTTP é SEMPRE relançada como `SupabaseAdminClientError`,
    nunca engolida silenciosamente, para que a camada de API decida o
    código HTTP apropriado e o chamador saiba com certeza se a operação
    foi ou não executada.

Headers: toda requisição envia `apikey: <service_role_key>` e
`Authorization: Bearer <service_role_key>` — exigidos pela API Admin do
GoTrue. O valor da service role key NUNCA é incluído em nenhuma mensagem
de log deste módulo, em nenhuma circunstância (nem em mensagens de erro,
nem em modo debug) — mesma garantia que `N8nClient` dá para sua API key.

Endurecimento (auditoria AppSec 2026-10-13): ids interpolados no path são
validados por allowlist e codificados (`_safe_path_segment`); `SUPABASE_URL`
precisa ser HTTPS (http só para localhost fora de produção); redirects nunca
são seguidos (o header `apikey` não é removido pelo `requests` em redirect
entre hosts); respostas são validadas como objetos JSON.
"""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote, urlparse

import requests

from app.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

# Segmentos de path aceitos para ids interpolados na URL da API Admin
# (`auth_user_id`, `factor_id`). O GoTrue usa UUIDs, mas a allowlist é um
# pouco mais ampla (letras, dígitos, `-`, `_`) para não acoplar este cliente
# ao formato exato; o essencial é REJEITAR `.`/`..`, `/`, `?`, `#`, `%` e
# espaços — com eles, `requests`/`urllib3` normalizam dot-segments e um
# `factor_id=".."` transformava `DELETE .../users/{id}/factors/..` em
# `DELETE .../users/{id}/` (exclusão do usuário inteiro no Supabase Auth com
# a Service Role Key). Ver auditoria 2026-10-13 (CWE-22/CWE-918).
_SAFE_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

_LOCAL_DEV_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Forma mínima de e-mail aceita antes de chamar `/recover` (o e-mail vem do
# banco local, nunca do cliente; checagem defensiva de formato/tamanho).
_EMAIL_SHAPE_RE = re.compile(r"[^@\s]{1,64}@[^@\s]{1,189}")

# Forma aceita para o `hashed_token` devolvido por `admin/generate_link`:
# base64url/hex do GoTrue. Serve para recusar lixo (HTML de proxy, mensagem de
# erro) ANTES de o valor virar query string de um link enviado por e-mail.
_TOKEN_HASH_SHAPE_RE = re.compile(r"[A-Za-z0-9._~+/=-]{16,512}")


def _safe_path_segment(value: Any, field_name: str) -> str:
    """Valida e codifica (`quote(safe="")`) um id usado como segmento de path."""
    if not isinstance(value, str) or not _SAFE_PATH_SEGMENT_RE.fullmatch(value):
        logger.warning(
            "supabase_admin_client: %s com formato inválido rejeitado antes da chamada.",
            field_name,
        )
        raise InvalidIdentifierError(f"Identificador '{field_name}' com formato inválido.")
    return quote(value, safe="")


def is_safe_supabase_base_url(base: str, settings: Any) -> bool:
    """`SUPABASE_URL` aceitável para tráfego com a Service Role Key.

    A chave nunca trafega fora de HTTPS. `http://` só para localhost fora de
    produção (Supabase CLI local). Sem credenciais embutidas, query ou
    fragment na URL base. Reutilizada por `supabase_storage_client`.
    """
    try:
        parsed = urlparse(base)
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return False
    is_production = bool(getattr(settings, "is_production", False))
    return (
        bool(hostname)
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and (
            parsed.scheme == "https"
            or (parsed.scheme == "http" and hostname in _LOCAL_DEV_HOSTS and not is_production)
        )
    )


class SupabaseAdminClientError(Exception):
    """Erro ao chamar a API Admin do Supabase Auth.

    A mensagem NUNCA contém a service role key nem qualquer outro segredo
    — apenas uma descrição segura do que falhou, para a camada de API
    decidir o código HTTP de resposta (ela NUNCA deve ser repassada ao
    cliente final sem passar pelo tratamento padronizado de `app.errors`).
    """


class InviteRedirectNotAllowedError(SupabaseAdminClientError):
    """`redirect_to` fora da allow-list configurada (`invite_allowed_redirect_urls`).

    Levantado ANTES de qualquer chamada de rede — proteção contra
    redirecionamento não autorizado após o convite.
    """


class MfaResetIncompleteError(SupabaseAdminClientError):
    """Remoção de fatores MFA incompleta; `removed` = quantos já foram removidos."""

    def __init__(self, removed: int) -> None:
        super().__init__("Remoção de fatores MFA incompleta.")
        self.removed = removed


class InvalidIdentifierError(SupabaseAdminClientError):
    """`auth_user_id`/`factor_id` fora do formato permitido para segmento de path.

    Levantado ANTES de qualquer chamada de rede. A camada de API deveria
    mapeá-lo para 400/404 (hoje cai no tratamento genérico de
    `SupabaseAdminClientError` -> 502).
    """


class SupabaseAdminClient:
    """Cliente para a API Admin do Supabase Auth (GoTrue), usando a Service Role Key.

    Ver docstring do módulo para as garantias de segurança (service role
    key nunca logada, erros sempre relançados, URLs de redirecionamento
    validadas contra uma allow-list).
    """

    def __init__(
        self,
        settings: Settings | None = None,
        session: requests.Session | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._settings = settings or get_settings()
        self._session = session or requests.Session()
        self._timeout_seconds = timeout_seconds

    # -- infraestrutura interna -------------------------------------------------

    def _base_url(self) -> str:
        base = (self._settings.supabase_url or "").strip().rstrip("/")
        if not base:
            raise SupabaseAdminClientError(
                "SUPABASE_URL não configurada; API Admin do Supabase indisponível."
            )
        if not is_safe_supabase_base_url(base, self._settings):
            logger.error(
                "supabase_admin_client: SUPABASE_URL rejeitada (HTTPS obrigatório); "
                "chamada à API Admin bloqueada."
            )
            raise SupabaseAdminClientError(
                "SUPABASE_URL inválida: HTTPS é obrigatório para a API Admin do Supabase."
            )
        return base

    def _headers(self) -> dict[str, str]:
        service_role_key = self._settings.supabase_service_role_key
        if not service_role_key:
            raise SupabaseAdminClientError(
                "SUPABASE_SERVICE_ROLE_KEY não configurada; API Admin do Supabase "
                "indisponível."
            )
        # O valor de `service_role_key` é usado aqui, mas NUNCA incluído em
        # nenhuma mensagem de log deste módulo.
        return {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> requests.Response:
        """Executa uma requisição HTTP à API Admin, convertendo qualquer falha
        (rede, timeout, HTTP 4xx/5xx) em `SupabaseAdminClientError`.

        Nunca engole a falha silenciosamente (diferente de `N8nClient`) —
        estas são operações administrativas críticas.
        """
        url = f"{self._base_url()}{path}"
        headers = self._headers()
        try:
            response = self._session.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=params,
                timeout=self._timeout_seconds,
                # Nunca seguir redirects: `requests` remove `Authorization`
                # ao mudar de host, mas NÃO remove o header customizado
                # `apikey` (que carrega a Service Role Key) — um 3xx para
                # outro host vazaria a chave (CWE-200/API10).
                allow_redirects=False,
            )
        except requests.exceptions.RequestException as exc:
            # Nunca logar `headers`/`json_body` (poderiam conter e-mail, mas
            # nunca a service role key, que fica só em `headers` — ainda
            # assim, por segurança, não logamos o dict de headers inteiro).
            logger.error(
                "supabase_admin_client: falha de rede ao chamar %s %s (%s).",
                method,
                path,
                exc.__class__.__name__,
            )
            raise SupabaseAdminClientError(
                f"Falha de rede ao chamar a API Admin do Supabase ({exc.__class__.__name__})."
            ) from exc

        if response.status_code >= 300:
            logger.error(
                "supabase_admin_client: API Admin do Supabase respondeu %d para %s %s.",
                response.status_code,
                method,
                path,
            )
            raise SupabaseAdminClientError(
                f"API Admin do Supabase respondeu com status HTTP {response.status_code} "
                f"para {method} {path}."
            )

        return response

    # -- operações públicas -------------------------------------------------

    def invite_user_by_email(self, email: str, name: str, redirect_to: str) -> dict[str, Any]:
        """Convida um novo usuário por e-mail (`POST /auth/v1/invite`).

        ANTES de qualquer chamada de rede, valida que `redirect_to` está na
        lista `settings.invite_allowed_redirect_urls_list` (URLs
        previamente autorizadas) — se não estiver, levanta
        `InviteRedirectNotAllowedError` SEM chamar a API (proteção contra
        redirecionamento não autorizado).

        Retorna o payload JSON da resposta do GoTrue; o `id` nele presente
        é o `auth_user_id` do usuário convidado/criado no Supabase Auth.
        """
        allowed = self._settings.invite_allowed_redirect_urls_list
        if redirect_to not in allowed:
            logger.warning(
                "supabase_admin_client: tentativa de convite com redirect_to fora da "
                "allow-list; chamada à API Admin bloqueada."
            )
            raise InviteRedirectNotAllowedError(
                "A URL de redirecionamento informada não está na lista de URLs "
                "previamente autorizadas."
            )

        response = self._request(
            "POST",
            "/auth/v1/invite",
            # O GoTrue lê `redirect_to` da QUERY STRING (no corpo é ignorado e o
            # e-mail cai no Site URL). Corpo: só e-mail e metadados.
            json_body={"email": email, "data": {"name": name}},
            params={"redirect_to": redirect_to},
        )
        return self._json_object(response, "convite")

    @staticmethod
    def _json_object(response: requests.Response, operation: str) -> dict[str, Any]:
        """Valida que a resposta upstream é um objeto JSON (API10)."""
        try:
            payload = response.json()
        except ValueError as exc:
            logger.error("supabase_admin_client: resposta não-JSON em %s.", operation)
            raise SupabaseAdminClientError(
                f"Resposta inválida da API Admin do Supabase ({operation})."
            ) from exc
        if not isinstance(payload, dict):
            logger.error("supabase_admin_client: resposta JSON não-objeto em %s.", operation)
            raise SupabaseAdminClientError(
                f"Resposta inválida da API Admin do Supabase ({operation})."
            )
        return payload

    def list_mfa_factors(self, auth_user_id: str) -> list[dict[str, Any]]:
        """Lista os fatores MFA cadastrados de um usuário.

        Lê o payload de `GET /auth/v1/admin/users/{auth_user_id}` — na
        resposta administrativa do GoTrue, os fatores MFA vêm no campo
        `factors` do objeto do usuário. Retorna `[]` se o campo estiver
        ausente (usuário sem nenhum fator cadastrado).
        """
        user_segment = _safe_path_segment(auth_user_id, "auth_user_id")
        response = self._request("GET", f"/auth/v1/admin/users/{user_segment}")
        payload = self._json_object(response, "listar fatores MFA")
        factors = payload.get("factors") or []
        if not isinstance(factors, list):
            raise SupabaseAdminClientError(
                "Resposta inválida da API Admin do Supabase (listar fatores MFA)."
            )
        # Só objetos são repassados (consumidores usam `.get(...)`).
        return [factor for factor in factors if isinstance(factor, dict)]

    def delete_mfa_factor(self, auth_user_id: str, factor_id: str) -> None:
        """Remove um fator MFA específico de um usuário (recuperação administrativa).

        Chama o endpoint administrativo de remoção de fator do GoTrue
        (`DELETE /auth/v1/admin/users/{auth_user_id}/factors/{factor_id}`).
        Não retorna nada em caso de sucesso; qualquer falha é levantada como
        `SupabaseAdminClientError`.
        """
        user_segment = _safe_path_segment(auth_user_id, "auth_user_id")
        factor_segment = _safe_path_segment(factor_id, "factor_id")
        self._request(
            "DELETE", f"/auth/v1/admin/users/{user_segment}/factors/{factor_segment}"
        )

    def deactivate_user(self, auth_user_id: str) -> None:
        """Desativa/revoga o acesso de um usuário (bane-o no Supabase Auth).

        Usa o endpoint admin de atualização de usuário
        (`PUT /auth/v1/admin/users/{auth_user_id}`) com o campo de ban do
        GoTrue (`ban_duration`), definido para um valor suficientemente
        longo para representar uma desativação administrativa (não há um
        valor "permanente" nativo no GoTrue; `"876000h"` (~100 anos) é o
        padrão usado por integrações do Supabase para esse fim).
        """
        self._request(
            "PUT",
            f"/auth/v1/admin/users/{_safe_path_segment(auth_user_id, 'auth_user_id')}",
            json_body={"ban_duration": "876000h"},
        )

    def ban_user(self, auth_user_id: str) -> None:
        """Bane o usuário no Supabase Auth (alias explícito de `deactivate_user`)."""
        self.deactivate_user(auth_user_id)

    def unban_user(self, auth_user_id: str) -> None:
        """Remove o banimento (`ban_duration: "none"`, valor do GoTrue para desbanir)."""
        self._request(
            "PUT",
            f"/auth/v1/admin/users/{_safe_path_segment(auth_user_id, 'auth_user_id')}",
            json_body={"ban_duration": "none"},
        )

    def generate_recovery_token_hash(self, email: str, redirect_to: str) -> str:
        """Cria o token de recuperação de senha SEM enviar e-mail algum.

        Usa `POST /auth/v1/admin/generate_link` com `type: "recovery"`: o
        GoTrue gera o token e DEVOLVE o `hashed_token` ao chamador, sem
        disparar mensagem. A entrega passa a ser deste backend
        (`app.services.password_reset_delivery`), com um link que aponta para
        a nossa própria página — e NÃO para `/auth/v1/verify`.

        POR QUE NÃO `/auth/v1/recover` (ver
        `docs/deploy/PLANO_ACAO_RESET_SENHA_2026-10-27.md`): o e-mail do
        Supabase usa `{{ .ConfirmationURL }}`, que é um GET de USO ÚNICO em
        `/auth/v1/verify`. Scanners de antivírus de e-mail abrem esse link
        automaticamente 2–4 s após o envio: gastam o token (a pessoa vê
        "link expirado") e, no fluxo implícito, RECEBEM access/refresh token
        válidos da conta. Corrigir pelo template do Supabase exigiria plano
        pago neste projeto, então a entrega virou responsabilidade nossa.

        Devolve SOMENTE o `hashed_token`. O `action_link` e o `email_otp` da
        resposta são descartados e NUNCA logados, auditados ou devolvidos a
        quem chamou a rota. O retorno é SEGREDO DE USO ÚNICO: o chamador não
        pode registrá-lo em log, auditoria nem resposta HTTP.
        """
        if redirect_to not in self._settings.invite_allowed_redirect_urls_list:
            logger.warning(
                "supabase_admin_client: geração de link de recuperação com redirect_to "
                "fora da allow-list; chamada bloqueada."
            )
            raise InviteRedirectNotAllowedError(
                "A URL de redirecionamento informada não está na lista de URLs "
                "previamente autorizadas."
            )
        if not isinstance(email, str) or not _EMAIL_SHAPE_RE.fullmatch(email):
            raise SupabaseAdminClientError("E-mail inválido para recuperação de senha.")
        response = self._request(
            "POST",
            "/auth/v1/admin/generate_link",
            # `redirect_to` aqui só compõe o `action_link` que descartamos; o
            # link enviado é montado por `password_reset_delivery`. Mantido
            # para o GoTrue validar o destino também do lado dele.
            json_body={"type": "recovery", "email": email, "redirect_to": redirect_to},
        )
        payload = self._json_object(response, "geração de link de recuperação")
        token_hash = payload.get("hashed_token")
        if not isinstance(token_hash, str) or not _TOKEN_HASH_SHAPE_RE.fullmatch(token_hash):
            # Nunca logar `payload`: ele carrega `action_link` e `email_otp`.
            logger.error(
                "supabase_admin_client: resposta de generate_link sem hashed_token válido."
            )
            raise SupabaseAdminClientError(
                "A API Admin do Supabase não devolveu um token de recuperação válido."
            )
        return token_hash

    def send_password_recovery(self, email: str, redirect_to: str) -> None:
        """Dispara o e-mail de recuperação de senha pelo PRÓPRIO Supabase Auth.

        ATENÇÃO — NÃO USE NO FLUXO DE REDEFINIÇÃO. O e-mail gerado aqui usa o
        template do painel (`{{ .ConfirmationURL }}`), cujo link de uso único
        é consumido por scanners de antivírus de e-mail antes do clique da
        pessoa, e que entrega access/refresh token ao scanner no fluxo
        implícito. Use `generate_recovery_token_hash` +
        `app.services.password_reset_delivery`. Mantido apenas porque o
        endpoint continua sendo o único caminho em que o link NUNCA passa por
        este backend, caso um dia o template do painel seja corrigido.

        Usa `POST /auth/v1/recover` (o mesmo endpoint de
        `supabase.auth.resetPasswordForEmail`): o GoTrue gera o link e envia o
        e-mail; a resposta não contém link nem token, portanto este backend
        nunca vê nem devolve credencial alguma (ao contrário de
        `admin/generate_link`, que devolveria o link ao chamador).

        `redirect_to` vai como query string (formato do GoTrue) e precisa estar
        na allow-list `INVITE_ALLOWED_REDIRECT_URLS`; fora dela levanta
        `InviteRedirectNotAllowedError` SEM chamada de rede.
        """
        if redirect_to not in self._settings.invite_allowed_redirect_urls_list:
            logger.warning(
                "supabase_admin_client: recuperação de senha com redirect_to fora da "
                "allow-list; chamada bloqueada."
            )
            raise InviteRedirectNotAllowedError(
                "A URL de redirecionamento informada não está na lista de URLs "
                "previamente autorizadas."
            )
        if not isinstance(email, str) or not _EMAIL_SHAPE_RE.fullmatch(email):
            raise SupabaseAdminClientError("E-mail inválido para recuperação de senha.")
        self._request(
            "POST",
            "/auth/v1/recover",
            json_body={"email": email},
            params={"redirect_to": redirect_to},
        )

    def delete_all_mfa_factors(self, auth_user_id: str) -> int:
        """Remove TODOS os fatores MFA do usuário; retorna quantos foram removidos.

        UA-MFA-01: fator com `id` fora do formato seguro NÃO é ignorado em
        silêncio — é logado (sem o id) e contado como falha. Qualquer falha
        (id inválido, rede/HTTP no meio do processo) levanta
        `MfaResetIncompleteError` com `removed` (quantos JÁ foram removidos),
        para o chamador encerrar as sessões mesmo no reset parcial. A operação
        é idempotente: repetir remove o restante.
        """
        factors = self.list_mfa_factors(auth_user_id)
        removed = 0
        failures = 0
        for factor in factors:
            factor_id = factor.get("id")
            if not isinstance(factor_id, str) or not _SAFE_PATH_SEGMENT_RE.fullmatch(factor_id):
                failures += 1
                logger.warning(
                    "supabase_admin_client: fator MFA com id em formato inválido; não removido "
                    "(contado como falha)."
                )
                continue
            try:
                self.delete_mfa_factor(auth_user_id, factor_id)
            except SupabaseAdminClientError as exc:
                raise MfaResetIncompleteError(removed) from exc
            removed += 1
        if failures:
            raise MfaResetIncompleteError(removed)
        return removed
