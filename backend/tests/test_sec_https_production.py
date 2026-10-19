"""M1/M2: em producao CORS e redirects de convite exigem https; localhost segue valido fora dela."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config.settings import Settings


def _kw(**over):
    base = dict(
        _env_file=None,
        database_url="postgresql+psycopg2://u:p@localhost/db",
        secret_key="s" * 40,
        supabase_jwt_secret="j" * 40,
        flask_env="production",
        cors_allowed_origins="https://app.example.test",
        invite_allowed_redirect_urls="https://app.example.test/ativar-conta",
    )
    base.update(over)
    return base


def test_producao_https_ok():
    assert Settings(**_kw()).is_production


@pytest.mark.parametrize("campo", ["cors_allowed_origins", "invite_allowed_redirect_urls"])
@pytest.mark.parametrize(
    "valor",
    ["http://app.example.test", "http://localhost:3000", "https://ok.example.test,http://x.test", "*"],
)
def test_producao_recusa_item_nao_https(campo, valor):
    with pytest.raises(ValidationError):
        Settings(**_kw(**{campo: valor}))


def test_producao_cors_padrao_localhost_recusado():
    kw = _kw()
    kw.pop("cors_allowed_origins")
    with pytest.raises(ValidationError):
        Settings(**kw)


@pytest.mark.parametrize("env", ["development", "testing"])
def test_localhost_http_permitido_fora_de_producao(env):
    s = Settings(**_kw(
        flask_env=env,
        cors_allowed_origins="http://localhost:3000",
        invite_allowed_redirect_urls="http://localhost:3000/ativar-conta",
    ))
    assert not s.is_production
