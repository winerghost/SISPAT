"""Cliente JWKS mínimo e estrito para JWTs ES256 do Supabase Auth.

Por que não `jwt.PyJWKClient`: ele usa `urllib` sem controle de redirects,
sem limite de tamanho de resposta e sem backoff/rate limit de refetch. Aqui
usamos `requests` com `allow_redirects=False`, timeout curto, leitura
limitada, cache com TTL, lock (anti thundering herd) e fail-closed.

Segurança:
    - URL SOMENTE de `settings.supabase_jwks_effective_url`; HTTPS
      obrigatório em produção;
    - só chaves `kty=EC`, `crv=P-256`, `use` in {sig, ausente}; `alg`
      (se presente) deve ser ES256;
    - `kid` desconhecido => no máximo um refetch a cada
      `_MIN_REFETCH_INTERVAL` s; depois, rejeita;
    - JWKS indisponível: usa cache (mesmo expirado, até
      `_MAX_STALE_FACTOR` x TTL); sem cache => `JwksUnavailableError`.
Nenhum token é registrado aqui.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

import jwt
import requests
from jwt.algorithms import ECAlgorithm

logger = logging.getLogger(__name__)

_MAX_RESPONSE_BYTES = 64 * 1024
_MAX_KEYS = 20
_MAX_KID_LENGTH = 128
_MIN_REFETCH_INTERVAL = 30.0  # s, entre buscas bem-sucedidas (kid desconhecido)
_FAILURE_BACKOFF = 5.0  # s, entre tentativas após falha
_MAX_STALE_FACTOR = 6


class JwksUnavailableError(jwt.PyJWTError):
    """JWKS indisponível/inválido e sem cache utilizável (fail-closed)."""

    audit_reason = "jwks_unavailable"


class UnknownKidError(jwt.PyJWTError):
    """`kid` ausente do JWKS (após o refetch permitido)."""

    audit_reason = "invalid_token:UnknownKid"


_lock = threading.Lock()
_keys: dict[str, Any] = {}
_fetched_at: float | None = None  # monotonic da última busca bem-sucedida
_last_attempt_at: float | None = None
_cache_url: str | None = None


def reset_jwks_cache() -> None:
    """Limpa o cache (uso em testes)."""
    global _keys, _fetched_at, _last_attempt_at, _cache_url
    with _lock:
        _keys, _fetched_at, _last_attempt_at, _cache_url = {}, None, None, None


def _fetch_jwks(url: str, timeout: float) -> dict[str, Any]:
    """Busca e valida o JWKS; levanta `JwksUnavailableError` em qualquer falha."""
    resp = None
    try:
        resp = requests.get(
            url,
            timeout=timeout,
            allow_redirects=False,
            stream=True,
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:  # inclui 3xx: redirect nunca é seguido
            raise JwksUnavailableError(f"status {resp.status_code}")
        declared = resp.headers.get("Content-Length") if getattr(resp, "headers", None) else None
        if declared and declared.isdigit() and int(declared) > _MAX_RESPONSE_BYTES:
            raise JwksUnavailableError("response too large")
        buf = bytearray()
        for chunk in resp.iter_content(chunk_size=8192):
            buf.extend(chunk)
            if len(buf) > _MAX_RESPONSE_BYTES:
                raise JwksUnavailableError("response too large")
        data = json.loads(bytes(buf).decode("utf-8"))
    except JwksUnavailableError:
        raise
    except (requests.RequestException, ValueError, UnicodeDecodeError) as exc:
        raise JwksUnavailableError(exc.__class__.__name__) from None
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass

    if not isinstance(data, dict) or not isinstance(data.get("keys"), list):
        raise JwksUnavailableError("invalid jwks")
    parsed: dict[str, Any] = {}
    for jwk in data["keys"][:_MAX_KEYS]:
        if not isinstance(jwk, dict):
            continue
        kid = jwk.get("kid")
        if (
            jwk.get("kty") != "EC"
            or jwk.get("crv") != "P-256"
            or jwk.get("use") not in (None, "sig")
            or jwk.get("alg") not in (None, "ES256")
            or not isinstance(kid, str)
            or not kid
            or len(kid) > _MAX_KID_LENGTH
            or not isinstance(jwk.get("x"), str)
            or not isinstance(jwk.get("y"), str)
            or "d" in jwk  # nunca aceitar chave privada
        ):
            continue
        try:
            parsed[kid] = ECAlgorithm.from_jwk(json.dumps(jwk))
        except Exception:  # noqa: BLE001 - chave malformada: ignora
            continue
    if not parsed:
        raise JwksUnavailableError("no usable keys")
    return parsed


def get_signing_key(kid: str, settings: Any) -> Any:
    """Retorna a chave pública EC para `kid` (ou levanta erro fail-closed)."""
    global _keys, _fetched_at, _last_attempt_at, _cache_url
    url = settings.supabase_jwks_effective_url
    if not url:
        raise JwksUnavailableError("no jwks url")
    if settings.is_production and not url.lower().startswith("https://"):
        raise JwksUnavailableError("https required")
    ttl = float(settings.supabase_jwks_cache_seconds)
    timeout = float(settings.supabase_jwks_timeout_seconds)

    with _lock:
        now = time.monotonic()
        if _cache_url != url:
            _keys, _fetched_at, _last_attempt_at, _cache_url = {}, None, None, url

        fresh = _fetched_at is not None and (now - _fetched_at) < ttl
        if fresh and kid in _keys:
            return _keys[kid]

        if fresh:
            # kid desconhecido com cache fresco: um refetch, rate limited.
            need_fetch = (now - (_fetched_at or 0)) >= _MIN_REFETCH_INTERVAL
        else:
            need_fetch = True

        if need_fetch and _last_attempt_at is not None and _fetched_at is None:
            # sem cache e última tentativa falhou há pouco: backoff curto.
            if now - _last_attempt_at < _FAILURE_BACKOFF:
                need_fetch = False

        if need_fetch:
            _last_attempt_at = now
            try:
                _keys = _fetch_jwks(url, timeout)
                _fetched_at = now
            except JwksUnavailableError:
                logger.warning("JWKS indisponível ou inválido; usando cache se houver.")
                stale_ok = _fetched_at is not None and (now - _fetched_at) < ttl * _MAX_STALE_FACTOR
                if not (stale_ok and kid in _keys):
                    raise
                return _keys[kid]
            if kid in _keys:
                return _keys[kid]
            raise UnknownKidError("unknown kid")

        if kid in _keys and _fetched_at is not None and (now - _fetched_at) < ttl * _MAX_STALE_FACTOR:
            return _keys[kid]
        if _fetched_at is None:
            raise JwksUnavailableError("jwks unavailable")
        raise UnknownKidError("unknown kid")
