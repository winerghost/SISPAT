"""Configuração do ambiente Alembic para o SISPAT-AGU.

A URL de conexão é lida de `DATABASE_URL` (variável de ambiente), nunca
hardcoded. É possível rodar tanto em modo "offline" (gera apenas o SQL, sem
conectar ao banco) quanto "online" (aplica diretamente via SQLAlchemy).
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Garante que o pacote `app` (backend/app) seja importável quando o Alembic
# é executado a partir de backend/ (script_location = migrations).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    # Carrega variáveis de um .env local, se existir (não obrigatório).
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - python-dotenv pode não estar instalado
    pass

# Importa a Base declarativa e todos os modelos, para popular o metadata
# usado pelo autogenerate do Alembic.
from app.database.session import Base  # noqa: E402
import app.models  # noqa: E402,F401

# Objeto de configuração do Alembic, que dá acesso aos valores do alembic.ini.
config = context.config

# Interpreta o arquivo de configuração para logging do Python.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Metadata alvo, usado pelo comando 'autogenerate'.
target_metadata = Base.metadata


def _get_database_url() -> str:
    """Resolve a URL do banco a partir de DATABASE_URL, sem valor hardcoded."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "A variável de ambiente DATABASE_URL não está definida. "
            "Configure-a (ex.: em backend/.env) antes de rodar o Alembic."
        )
    return url


def run_migrations_offline() -> None:
    """Executa migrações em modo 'offline' (gera SQL, sem conectar ao banco)."""
    url = _get_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Executa migrações em modo 'online' (conecta ao banco via SQLAlchemy)."""
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = _get_database_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
