"""Helpers dos testes de e-mail (valores FICTICIOS; zero rede)."""
from __future__ import annotations

from app.config.settings import Settings

FAKE_PASSWORD = "abcdwxyzabcdwxyz"  # fictício


def make_settings(**overrides) -> Settings:
    base = dict(
        database_url="postgresql+psycopg2://u:p@localhost:5432/t",
        secret_key="x" * 40,
        flask_env="testing",
        email_enabled=True,
        email_host="smtp.example.test",
        email_port=587,
        email_user="robo@example.test",
        email_password=FAKE_PASSWORD,
        email_from="robo@example.test",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)
