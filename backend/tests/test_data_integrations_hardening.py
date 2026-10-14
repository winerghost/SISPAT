"""Testes de regressão — integrações (SSRF/API7, consumo inseguro/API10, A04).

Auditoria AppSec 2026-10-13 (backend-data). Nenhuma chamada de rede real:
`requests.Session.post/request` são sempre mockados. Segredos são
sentinelas sintéticas.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.config.settings import Settings
from app.database.session import build_connect_args
from app.integrations.n8n_client import N8nClient, _looks_secure_or_local
from app.integrations.supabase_admin_client import (
    InvalidIdentifierError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)

_SECRET = "sentinela-service-role-key-sintetica-0000"
_USER = "11111111-1111-1111-1111-111111111111"
_FACTOR = "22222222-2222-2222-2222-222222222222"


def _settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "database_url": "postgresql+psycopg2://user:pass@localhost:5432/test",
        "secret_key": "test-secret-key",
        "flask_env": "testing",
        "supabase_url": "https://proj.supabase.co",
        "supabase_service_role_key": _SECRET,
        "n8n_integration_enabled": True,
        "n8n_webhook_url": "https://n8n.exemplo.com/webhook/sispat",
        "n8n_api_key": "sentinela-n8n-key",
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def _ok(status: int = 200, payload: object | None = None) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.json.return_value = payload if payload is not None else {}
    return response


# ---------------------------------------------------------------------------
# n8n: HTTPS obrigatório, sem bypass de "localhost", sem redirects
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://n8n.exemplo.com/webhook",
        "http://localhost.atacante.com/webhook",
        "http://localhost@atacante.com/webhook",
        "http://127.0.0.1.nip.io/webhook",
        "https://user:pass@n8n.exemplo.com/webhook",
        "ftp://n8n.exemplo.com/",
        "javascript:alert(1)",
    ],
)
def test_n8n_url_insegura_e_bloqueada_sem_chamada_de_rede(url: str) -> None:
    assert _looks_secure_or_local(url) is False
    client = N8nClient(settings=_settings(n8n_webhook_url=url))
    with patch("requests.Session.post") as mock_post:
        result = client.trigger_webhook("asset.created", {"asset_id": "x"})
    mock_post.assert_not_called()
    assert result.success is False
    assert "HTTPS" in (result.error or "")


def test_n8n_localhost_http_permitido_so_fora_de_producao() -> None:
    dev = N8nClient(settings=_settings(n8n_webhook_url="http://localhost:5678/webhook"))
    with patch("requests.Session.post", return_value=_ok()) as mock_post:
        assert dev.trigger_webhook("e", {}).success is True
    mock_post.assert_called_once()

    prod_settings = _settings(
        n8n_webhook_url="http://localhost:5678/webhook",
        flask_env="production",
        secret_key="x" * 64,
        supabase_jwt_secret="y" * 64,
    )
    prod = N8nClient(settings=prod_settings)
    with patch("requests.Session.post") as mock_post_prod:
        assert prod.trigger_webhook("e", {}).success is False
    mock_post_prod.assert_not_called()


def test_n8n_nao_segue_redirects_e_trata_3xx_como_falha() -> None:
    client = N8nClient(settings=_settings())
    with patch("requests.Session.post", return_value=_ok(307)) as mock_post:
        result = client.trigger_webhook("asset.created", {})
    assert mock_post.call_args.kwargs["allow_redirects"] is False
    assert result.success is False
    assert result.status_code == 307


def test_n8n_falha_nunca_propaga_por_padrao() -> None:
    import requests

    client = N8nClient(settings=_settings())
    with patch("requests.Session.post", side_effect=requests.exceptions.ConnectionError()):
        with patch("app.integrations.n8n_client.time.sleep"):
            result = client.trigger_webhook("asset.created", {}, max_attempts=2)
    assert result.success is False


# ---------------------------------------------------------------------------
# Supabase Admin: path traversal, HTTPS, redirects, validação de resposta
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "factor_id",
    ["..", ".", "../../invite", "a/b", "x?y=1", "x#y", "%2e%2e", "a b", "", "a" * 129],
)
def test_delete_mfa_factor_rejeita_segmento_malicioso_sem_chamar_api(factor_id: str) -> None:
    """Regressão do achado: `factor_id='..'` virava
    `DELETE /auth/v1/admin/users/<id>/` (exclusão do usuário inteiro)."""
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request") as mock_request:
        with pytest.raises(InvalidIdentifierError):
            client.delete_mfa_factor(_USER, factor_id)
    mock_request.assert_not_called()


@pytest.mark.parametrize("user_id", ["..", "x/../../invite", "a?b", None, 123])
def test_operacoes_admin_rejeitam_auth_user_id_malicioso(user_id: object) -> None:
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request") as mock_request:
        with pytest.raises(InvalidIdentifierError):
            client.list_mfa_factors(user_id)  # type: ignore[arg-type]
        with pytest.raises(InvalidIdentifierError):
            client.deactivate_user(user_id)  # type: ignore[arg-type]
    mock_request.assert_not_called()


def test_delete_mfa_factor_valido_monta_url_exata_sem_redirect() -> None:
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request", return_value=_ok(204)) as mock_request:
        client.delete_mfa_factor(_USER, _FACTOR)
    args, kwargs = mock_request.call_args
    assert args == (
        "DELETE",
        f"https://proj.supabase.co/auth/v1/admin/users/{_USER}/factors/{_FACTOR}",
    )
    assert kwargs["allow_redirects"] is False


def test_redirect_da_api_admin_e_tratado_como_erro() -> None:
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request", return_value=_ok(302)):
        with pytest.raises(SupabaseAdminClientError):
            client.deactivate_user(_USER)


@pytest.mark.parametrize(
    "url",
    [
        "http://proj.supabase.co",
        "https://user:pass@proj.supabase.co",
        "https://proj.supabase.co?x=1",
        "ftp://proj.supabase.co",
    ],
)
def test_supabase_url_insegura_bloqueia_antes_de_enviar_a_service_role_key(url: str) -> None:
    client = SupabaseAdminClient(settings=_settings(supabase_url=url))
    with patch("requests.Session.request") as mock_request:
        with pytest.raises(SupabaseAdminClientError):
            client.deactivate_user(_USER)
    mock_request.assert_not_called()


def test_supabase_local_http_permitido_fora_de_producao() -> None:
    client = SupabaseAdminClient(settings=_settings(supabase_url="http://127.0.0.1:54321"))
    with patch("requests.Session.request", return_value=_ok(200)) as mock_request:
        client.deactivate_user(_USER)
    mock_request.assert_called_once()


@pytest.mark.parametrize("payload", [["lista"], "texto", 42])
def test_resposta_admin_nao_objeto_vira_erro(payload: object) -> None:
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request", return_value=_ok(200, payload)):
        with pytest.raises(SupabaseAdminClientError):
            client.list_mfa_factors(_USER)


def test_resposta_admin_nao_json_vira_erro() -> None:
    response = _ok(200)
    response.json.side_effect = ValueError("not json")
    client = SupabaseAdminClient(settings=_settings())
    with patch("requests.Session.request", return_value=response):
        with pytest.raises(SupabaseAdminClientError):
            client.list_mfa_factors(_USER)


def test_factors_com_tipo_inesperado_sao_filtrados_ou_rejeitados() -> None:
    client = SupabaseAdminClient(settings=_settings())
    payload = {"factors": [{"id": _FACTOR, "status": "verified"}, "lixo", 3]}
    with patch("requests.Session.request", return_value=_ok(200, payload)):
        assert client.list_mfa_factors(_USER) == [{"id": _FACTOR, "status": "verified"}]
    with patch("requests.Session.request", return_value=_ok(200, {"factors": "x"})):
        with pytest.raises(SupabaseAdminClientError):
            client.list_mfa_factors(_USER)


def test_service_role_key_nunca_em_logs_nem_em_mensagens_de_erro(caplog) -> None:
    client = SupabaseAdminClient(settings=_settings(supabase_url="http://proj.supabase.co"))
    caplog.set_level("DEBUG")
    with pytest.raises(SupabaseAdminClientError) as exc_info:
        client.deactivate_user(_USER)
    assert _SECRET not in caplog.text
    assert _SECRET not in str(exc_info.value)


# ---------------------------------------------------------------------------
# Conexão com o banco (A04): TLS e timeouts
# ---------------------------------------------------------------------------


@pytest.fixture()
def _clean_db_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in ("DB_SSLMODE", "DB_SSLROOTCERT", "DB_CONNECT_TIMEOUT", "DB_STATEMENT_TIMEOUT_MS"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg2://u:p@db.abcdefgh.supabase.co:5432/postgres",
        "postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
    ],
)
def test_supabase_sem_sslmode_forca_require(_clean_db_env, url: str) -> None:
    args = build_connect_args(url)
    assert args["sslmode"] == "require"
    assert args["connect_timeout"] == 10


def test_sslmode_explicito_na_url_e_respeitado(_clean_db_env) -> None:
    args = build_connect_args(
        "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres?sslmode=verify-full"
    )
    assert "sslmode" not in args  # URL prevalece (verify-full)


def test_host_local_nao_e_alterado(_clean_db_env) -> None:
    args = build_connect_args("postgresql+psycopg2://u:p@postgres-dev:5432/sispat")
    assert "sslmode" not in args


def test_overrides_por_ambiente(_clean_db_env) -> None:
    _clean_db_env.setenv("DB_SSLMODE", "verify-full")
    _clean_db_env.setenv("DB_SSLROOTCERT", "/run/secrets/supabase-ca.crt")
    _clean_db_env.setenv("DB_STATEMENT_TIMEOUT_MS", "15000")
    _clean_db_env.setenv("DB_CONNECT_TIMEOUT", "5")
    args = build_connect_args("postgresql://u:p@localhost:5432/x")
    assert args["sslmode"] == "verify-full"
    assert args["sslrootcert"] == "/run/secrets/supabase-ca.crt"
    assert args["options"] == "-c statement_timeout=15000"
    assert args["connect_timeout"] == 5


def test_statement_timeout_invalido_e_ignorado(_clean_db_env) -> None:
    _clean_db_env.setenv("DB_STATEMENT_TIMEOUT_MS", "1; DROP TABLE assets")
    args = build_connect_args("postgresql://u:p@localhost:5432/x")
    assert "options" not in args


def test_engine_usa_pre_ping() -> None:
    from app.database.session import engine

    assert engine.pool._pre_ping is True  # noqa: SLF001


def test_producao_host_remoto_sem_sslmode_recebe_require(_clean_db_env) -> None:
    args = build_connect_args("postgresql://u:p@db.interno.exemplo:5432/x", is_production=True)
    assert args["sslmode"] == "require"


@pytest.mark.parametrize("mode", ["disable", "allow", "prefer"])
def test_producao_recusa_sslmode_fraco_na_url(_clean_db_env, mode: str) -> None:
    with pytest.raises(RuntimeError):
        build_connect_args(
            f"postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres?sslmode={mode}",
            is_production=True,
        )


def test_producao_recusa_db_sslmode_fraco(_clean_db_env) -> None:
    _clean_db_env.setenv("DB_SSLMODE", "disable")
    with pytest.raises(RuntimeError):
        build_connect_args("postgresql://u:p@db.abcdefgh.supabase.co/x", is_production=True)


def test_producao_aceita_verify_full_e_loopback(_clean_db_env) -> None:
    build_connect_args(
        "postgresql://u:p@db.abcdefgh.supabase.co/x?sslmode=verify-full", is_production=True
    )
    assert "sslmode" not in build_connect_args("postgresql://u:p@127.0.0.1/x", is_production=True)
