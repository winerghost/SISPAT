"""Cliente HTTP mínimo para o Supabase Storage (bucket PRIVADO `avatars`).

Usado só pelo backend (`app.services.avatar_service`) com a Service Role Key;
o navegador nunca fala com o Storage diretamente e só recebe URLs assinadas de
curta duração (300 s). Mesmo padrão de segurança HTTP de
`app.integrations.supabase_admin_client`:

    - `SUPABASE_URL` precisa ser HTTPS (http só para localhost fora de
      produção) — validação compartilhada `is_safe_supabase_base_url`;
    - `timeout` em toda chamada e `allow_redirects=False` (o header `apikey`
      com a Service Role Key não é removido pelo `requests` num redirect);
    - o nome do objeto é validado por allowlist ESTRITA (`<uuid4>.webp`) antes
      de ser interpolado no path — nada vindo do cliente chega à URL;
    - respostas validadas (objeto JSON; URL assinada relativa ao próprio
      bucket, sem esquema/host);
    - nenhuma chave, token ou URL assinada é logada; erros só com a classe da
      exceção ou o status HTTP.

Qualquer falha (configuração ausente, rede, HTTP >= 300, bucket inexistente,
resposta inesperada) vira `StorageUnavailableError`; a camada de API responde
503 `storage_unavailable` e o resto do sistema segue funcionando.

O bucket `avatars` NÃO é criado por este código: o SQL versionado está em
`backend/migrations/sql/0008_storage_avatars.sql` (não aplicado; requer
autorização).
"""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote

import requests

from app.config.settings import Settings, get_settings
from app.integrations.supabase_admin_client import is_safe_supabase_base_url

logger = logging.getLogger(__name__)

AVATAR_BUCKET = "avatars"
SIGNED_URL_TTL_SECONDS = 300

# `<uuid4>.webp` (minúsculas, com hífens) — único formato de objeto aceito.
OBJECT_KEY_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$"
)
_SIGNED_PATH_RE = re.compile(
    r"^/object/sign/" + AVATAR_BUCKET + r"/[0-9a-f-]{36}\.webp\?token=[A-Za-z0-9_.~%-]{1,4096}$"  # token JWT (base64url + pontos)
)
_MAX_UPLOAD_BYTES = 1_048_576  # o WebP 512x512 recodificado fica muito abaixo disso


class StorageUnavailableError(Exception):
    """Storage indisponível, mal configurado ou resposta inesperada (sem segredos)."""


def is_valid_object_key(value: Any) -> bool:
    return isinstance(value, str) and bool(OBJECT_KEY_RE.fullmatch(value))


class SupabaseStorageClient:
    """Upload, remoção e URL assinada de objetos do bucket privado `avatars`."""

    def __init__(
        self,
        settings: Settings | None = None,
        session: requests.Session | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._settings = settings or get_settings()
        self._session = session or requests.Session()
        self._timeout_seconds = timeout_seconds

    # -- infraestrutura -----------------------------------------------------

    def _base_url(self) -> str:
        base = (self._settings.supabase_url or "").strip().rstrip("/")
        if not base or not is_safe_supabase_base_url(base, self._settings):
            logger.error("supabase_storage_client: SUPABASE_URL ausente ou inválida.")
            raise StorageUnavailableError("Storage indisponível (configuração).")
        return base

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        key = self._settings.supabase_service_role_key
        if not key:
            logger.error("supabase_storage_client: SUPABASE_SERVICE_ROLE_KEY ausente.")
            raise StorageUnavailableError("Storage indisponível (configuração).")
        headers = {"apikey": key, "Authorization": f"Bearer {key}"}
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    @staticmethod
    def _object_path(object_key: str) -> str:
        if not is_valid_object_key(object_key):
            logger.warning("supabase_storage_client: nome de objeto inválido rejeitado.")
            raise StorageUnavailableError("Nome de objeto inválido.")
        return f"{AVATAR_BUCKET}/{quote(object_key, safe='')}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        content_type: str | None = None,
        data: bytes | None = None,
        json_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> requests.Response:
        url = f"{self._base_url()}/storage/v1{path}"
        headers = self._headers(content_type)
        if extra_headers:
            headers.update(extra_headers)
        try:
            response = self._session.request(
                method,
                url,
                headers=headers,
                data=data,
                json=json_body,
                timeout=self._timeout_seconds,
                allow_redirects=False,
            )
        except requests.exceptions.RequestException as exc:
            logger.error(
                "supabase_storage_client: falha de rede em %s (%s).",
                method,
                exc.__class__.__name__,
            )
            raise StorageUnavailableError("Storage indisponível (rede).") from exc
        if response.status_code >= 300:
            # 400/404 "Bucket not found" (bucket ainda não criado) também cai aqui.
            logger.error(
                "supabase_storage_client: Storage respondeu %d para %s.",
                response.status_code,
                method,
            )
            raise StorageUnavailableError(f"Storage respondeu HTTP {response.status_code}.")
        return response

    # -- operações -----------------------------------------------------------

    def upload(self, object_key: str, data: bytes, content_type: str = "image/webp") -> None:
        """Envia um objeto NOVO (sem sobrescrever: `x-upsert: false`)."""
        if content_type != "image/webp" or not isinstance(data, bytes) or not data:
            raise StorageUnavailableError("Conteúdo inválido para upload.")
        if len(data) > _MAX_UPLOAD_BYTES:
            raise StorageUnavailableError("Conteúdo acima do limite do bucket.")
        self._request(
            "POST",
            f"/object/{self._object_path(object_key)}",
            content_type=content_type,
            data=data,
            extra_headers={"x-upsert": "false", "cache-control": "no-store"},
        )

    def delete(self, object_key: str) -> None:
        self._request("DELETE", f"/object/{self._object_path(object_key)}")

    def create_signed_url(
        self, object_key: str, expires_in: int = SIGNED_URL_TTL_SECONDS
    ) -> str:
        """Gera URL assinada de leitura com validade curta (padrão 300 s)."""
        if not isinstance(expires_in, int) or not 1 <= expires_in <= SIGNED_URL_TTL_SECONDS:
            raise StorageUnavailableError("Validade da URL assinada fora do limite.")
        response = self._request(
            "POST",
            f"/object/sign/{self._object_path(object_key)}",
            content_type="application/json",
            json_body={"expiresIn": expires_in},
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise StorageUnavailableError("Resposta inválida do Storage.") from exc
        signed = payload.get("signedURL") if isinstance(payload, dict) else None
        if not isinstance(signed, str) or not _SIGNED_PATH_RE.fullmatch(signed):
            logger.error("supabase_storage_client: URL assinada em formato inesperado.")
            raise StorageUnavailableError("Resposta inválida do Storage.")
        if not signed.startswith(f"/object/sign/{AVATAR_BUCKET}/{object_key}?"):
            raise StorageUnavailableError("Resposta inválida do Storage.")
        return f"{self._base_url()}/storage/v1{signed}"
