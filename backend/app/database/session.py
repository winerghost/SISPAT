"""Configuração do engine SQLAlchemy, da fábrica de sessões e da Base declarativa.

Convenções desta aplicação:
    - Todas as colunas de data/hora são `TIMESTAMPTZ` (timezone-aware) no Postgres,
      e o aplicativo trata/gera valores Python sempre em UTC
      (`datetime.now(timezone.utc)`), nunca em horário local "naive".
    - O Postgres normaliza internamente qualquer `timestamptz` para UTC,
      independentemente do timezone da sessão que o escreveu.
"""
from __future__ import annotations

import os
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config.settings import get_settings

settings = get_settings()

# Hosts gerenciados pelo Supabase (conexão direta `db.<ref>.supabase.co` e
# pooler `*.pooler.supabase.com`): TLS é sempre suportado e deve ser exigido.
_SUPABASE_HOST_SUFFIXES = (".supabase.co", ".supabase.com")
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", ""})
_SECURE_SSLMODES = frozenset({"require", "verify-ca", "verify-full"})
_DEFAULT_CONNECT_TIMEOUT_SECONDS = 10
_DEFAULT_POOL_RECYCLE_SECONDS = 1800
_DEFAULT_POOL_TIMEOUT_SECONDS = 30


def _env_int(name: str, default: int | None) -> int | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def build_connect_args(database_url: str, is_production: bool = False) -> dict[str, Any]:
    """Parâmetros libpq/psycopg2 de conexão (auditoria AppSec 2026-10-13, A04).

    - `sslmode`: se a URL não definir `sslmode` e o host for do Supabase,
      força `require` (TLS obrigatório; sem isso o libpq usa `prefer`, que
      aceita downgrade para texto claro). `DB_SSLMODE` (env) sobrescreve
      explicitamente — recomenda-se `verify-full` com `DB_SSLROOTCERT`
      apontando para o CA do Supabase em produção. Hosts locais (ex.:
      `postgres-dev` do docker-compose.dev) não são alterados fora de
      produção. EM PRODUÇÃO (`is_production=True`), todo host não-loopback
      recebe `require` por padrão e um `sslmode` fraco explícito
      (`disable`/`allow`/`prefer`) faz a inicialização FALHAR (RuntimeError).
    - `connect_timeout`: `DB_CONNECT_TIMEOUT` (default 10 s) — evita threads
      presas indefinidamente na abertura de conexão.
    - `statement_timeout`: opcional, via `DB_STATEMENT_TIMEOUT_MS` (> 0),
      enviado como `options=-c statement_timeout=...`. Desligado por padrão
      porque o pooler em modo transação do Supabase pode não repassar
      `options`; a alternativa recomendada é `ALTER ROLE ... SET
      statement_timeout` no papel usado pelo backend.
    """
    connect_args: dict[str, Any] = {}
    try:
        url = make_url(database_url)
    except ArgumentError:
        return connect_args
    if not url.drivername.startswith("postgresql"):
        return connect_args

    query = {key.lower(): value for key, value in url.query.items()}
    host = (url.host or "").lower()
    is_local = host in _LOCAL_HOSTS

    explicit_sslmode = os.environ.get("DB_SSLMODE", "").strip()
    if explicit_sslmode:
        connect_args["sslmode"] = explicit_sslmode
    elif "sslmode" not in query and (
        host.endswith(_SUPABASE_HOST_SUFFIXES) or (is_production and not is_local)
    ):
        connect_args["sslmode"] = "require"

    if is_production and not is_local:
        effective = connect_args.get("sslmode") or query.get("sslmode")
        if isinstance(effective, (tuple, list)):
            effective = effective[-1]
        if str(effective).strip().lower() not in _SECURE_SSLMODES:
            # Fail-closed na inicialização: em produção, conexão com banco
            # remoto sem TLS obrigatório é recusada (A04).
            raise RuntimeError(
                "DATABASE_URL/DB_SSLMODE: em produção o sslmode deve ser "
                "require, verify-ca ou verify-full para hosts remotos."
            )
    sslrootcert = os.environ.get("DB_SSLROOTCERT", "").strip()
    if sslrootcert and "sslrootcert" not in query:
        connect_args["sslrootcert"] = sslrootcert

    if "connect_timeout" not in query:
        connect_args["connect_timeout"] = _env_int(
            "DB_CONNECT_TIMEOUT", _DEFAULT_CONNECT_TIMEOUT_SECONDS
        )

    statement_timeout_ms = _env_int("DB_STATEMENT_TIMEOUT_MS", None)
    if statement_timeout_ms and statement_timeout_ms > 0 and "options" not in query:
        # Inteiro validado acima — nenhum texto livre é interpolado aqui.
        connect_args["options"] = f"-c statement_timeout={int(statement_timeout_ms)}"

    connect_args.setdefault("application_name", "sispat-agu-backend")
    return connect_args


# `pool_pre_ping` evita erros de "conexão fechada pelo servidor" em conexões
# ociosas (comum em bancos gerenciados como o Supabase); `pool_recycle`
# renova conexões antes de timeouts de ociosidade do pooler; `pool_timeout`
# limita a espera por uma conexão livre do pool (falha rápida, A10).
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_recycle=_env_int("DB_POOL_RECYCLE_SECONDS", _DEFAULT_POOL_RECYCLE_SECONDS),
    pool_timeout=_env_int("DB_POOL_TIMEOUT_SECONDS", _DEFAULT_POOL_TIMEOUT_SECONDS),
    connect_args=build_connect_args(
        settings.database_url, is_production=bool(getattr(settings, "is_production", False))
    ),
    echo=settings.db_echo,
    future=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


class Base(DeclarativeBase):
    """Base declarativa SQLAlchemy 2.x para todos os modelos ORM do SISPAT-AGU."""


@contextmanager
def get_db_session() -> Generator[Session, None, None]:
    """Context manager que fornece uma `Session` e garante commit/rollback/close.

    Uso:
        with get_db_session() as db:
            db.add(obj)
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
