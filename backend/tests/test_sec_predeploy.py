"""Auditoria pré-deploy VPS (2026-10-14): prontidão do banco, sessão e configuração.

Complementa `test_sec_route_inventory.py` (toda rota exige login) com o que NÃO
depende só do código das rotas:

1. PREDEPLOY-01 (resolvido em 2026-10-15: 0005 aplicada em produção) — a
   consulta de `require_auth` carrega colunas de `users` criadas pela migração
   `0005_settings_ai_users`. Num banco sem a 0005, TODA requisição autenticada
   vira 500 (provado com SQL REAL num SQLite com o schema `users` da baseline
   0001) e o healthcheck continua 200; mantido como regressão.
2. AUD-14-08 — `users.sessions_revoked_at` está documentado no modelo como
   aplicado por `require_auth`, mas não é verificado: logout/revogação não
   invalidam um access token já emitido (vale até o `exp`).
3. PREDEPLOY-04 — produção inicia sem `SUPABASE_JWT_SECRET`/issuer.
4. Celery sem entrada de usuário; ProxyFix (1 hop) e o IP auditado.
5. Compose/Dockerfile de produção (análise estática do texto, sem Docker).
6. PREDEPLOY-03 — arquivos que o `.gitignore` declara locais estão rastreados.

Tudo com dados sintéticos; nenhum acesso a Supabase, VPS, Redis, Sheets ou n8n.
Falhas reais estão marcadas `xfail(strict=True)`: ao corrigir, remova o xfail.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import jwt
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app import create_app
from app.config.settings import Settings

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
JWT_SECRET = "test-jwt-secret-sintetico-com-32-bytes-ou-mais"  # = tests/conftest.py

# Colunas de `users` na baseline 0001 (backend/migrations/sql/0001_initial_schema.sql).
BASELINE_0001_USERS_COLUMNS = frozenset(
    {"id", "auth_user_id", "name", "email", "active", "created_at", "updated_at", "last_login_at"}
)
COLUMNS_FROM_0005 = frozenset(
    {"version", "sessions_revoked_at", "avatar_object_key", "deactivated_at", "deactivated_by"}
)
# Colunas da exclusão lógica de usuário (migração 0019_user_soft_delete,
# espelho sql/0022_user_soft_delete.sql). `require_auth` LÊ `deleted_at` para
# recusar (401) o JWT de um usuário excluído, então estas colunas entram na
# consulta de autenticação: aplicar o espelho `.sql` no banco é PRÉ-REQUISITO
# de implantar a imagem nova do backend (mesma classe do PREDEPLOY-01). A
# ordem está registrada no cabeçalho das duas migrações e no plano
# docs/deploy/PLANO_ACAO_USUARIOS_CONVITE_2026-10-28.md §2/§6.
COLUMNS_FROM_0019 = frozenset({"deleted_at", "deleted_by", "anonymized_at"})
# Estado REAL de `users` em produção. A 0005 foi aplicada em produção
# (verificação do coordenador em 2026-10-14, information_schema.columns;
# registrado em docs/security/evidence/settings-module-etapa2.md). Se uma
# migração futura adicionar colunas lidas por `require_auth`, atualize esta
# constante SOMENTE depois de confirmar a aplicação em produção.
PRODUCTION_USERS_COLUMNS = (
    BASELINE_0001_USERS_COLUMNS | COLUMNS_FROM_0005 | COLUMNS_FROM_0019
)


def _token(**overrides: Any) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": "auth-predeploy-1",
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "aal": "aal2",
    }
    claims.update(overrides)
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")


def _bearer(token: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token or _token()}"}


class _CapturingSession:
    """Sessão falsa que guarda o statement executado e devolve 'nenhum usuário'."""

    def __init__(self) -> None:
        self.statements: list[Any] = []

    def execute(self, stmt: Any) -> Any:
        self.statements.append(stmt)
        return SimpleNamespace(scalar_one_or_none=lambda: None)


def _auth_query_sql() -> tuple[str, set[str]]:
    """Executa o carregador REAL de `require_auth` e devolve (SQL, colunas de users)."""
    from app.auth import supabase_auth

    fake = _CapturingSession()

    @contextmanager
    def _session():
        yield fake

    with patch.object(supabase_auth, "get_db_session", _session):
        assert supabase_auth._load_user_with_roles_and_permissions("auth-predeploy-1") is None

    assert len(fake.statements) == 1
    sql = str(fake.statements[0].compile(dialect=postgresql.dialect()))
    columns = set(re.findall(r"\busers\.([a-z_]+)\b", sql.split(" FROM ")[0]))
    return sql, columns


def _users_columns_in_0001_sql() -> set[str]:
    sql = (BACKEND_DIR / "migrations" / "sql" / "0001_initial_schema.sql").read_text(encoding="utf-8")
    body = re.search(r"CREATE TABLE IF NOT EXISTS users \((.*?)\n\);", sql, re.S)
    assert body, "tabela users não encontrada na 0001"
    columns = set()
    for line in body.group(1).splitlines():
        match = re.match(r"\s+([a-z_]+)\s+(uuid|text|boolean|timestamptz|integer)", line)
        if match:
            columns.add(match.group(1))
    return columns


# ---------------------------------------------------------------------------
# 1) PREDEPLOY-01 — schema de produção x ORM em require_auth
# ---------------------------------------------------------------------------


def test_baseline_de_producao_confere_com_a_0001():
    """Sanidade da constante: o schema `users` da 0001 é exatamente a baseline."""
    assert _users_columns_in_0001_sql() == set(BASELINE_0001_USERS_COLUMNS)


def test_query_de_autenticacao_seleciona_colunas_criadas_pela_0005():
    """Evidência: o SELECT de `require_auth` (compilado para PostgreSQL) inclui
    as 5 colunas que só existem após a migração 0005."""
    sql, columns = _auth_query_sql()
    assert "FROM users" in sql and "users.auth_user_id = %(auth_user_id_1)s" in sql
    assert COLUMNS_FROM_0005 <= columns, sorted(columns)
    assert columns - set(BASELINE_0001_USERS_COLUMNS) == set(
        COLUMNS_FROM_0005 | COLUMNS_FROM_0019
    )


def test_0005_e_a_unica_migracao_que_cria_essas_colunas():
    from importlib import import_module

    m0005 = import_module("migrations.versions.0005_settings_ai_users")
    for column in COLUMNS_FROM_0005:
        assert f"ADD COLUMN IF NOT EXISTS {column} " in m0005.ALTER_USERS_SQL
    for name in ("0002_import_previews", "0003_invites", "0004_db_security_hardening"):
        source = (BACKEND_DIR / "migrations" / "versions" / f"{name}.py").read_text(encoding="utf-8")
        for column in COLUMNS_FROM_0005:
            assert not re.search(rf"users\b[^;]*ADD COLUMN[^;]*\b{column}\b", source, re.S | re.I)


def test_0019_e_a_unica_migracao_que_cria_as_colunas_de_exclusao_logica():
    """As colunas lidas por `require_auth` vêm SÓ da 0019 (e o espelho `.sql`
    precisa estar aplicado antes do deploy do backend — ver COLUMNS_FROM_0019)."""
    from importlib import import_module

    m0019 = import_module("migrations.versions.0019_user_soft_delete")
    for column in COLUMNS_FROM_0019:
        assert f"ADD COLUMN IF NOT EXISTS {column} " in m0019.ADD_COLUMNS_SQL
    mirror = (BACKEND_DIR / "migrations" / "sql" / "0022_user_soft_delete.sql").read_text(
        encoding="utf-8"
    )
    for column in COLUMNS_FROM_0019:
        assert f"ADD COLUMN IF NOT EXISTS {column} " in mirror
    _sql, columns = _auth_query_sql()
    assert "deleted_at" in columns  # é o que exige a ordem "migração antes do deploy"


def test_autenticacao_compativel_com_schema_de_producao():
    """PREDEPLOY-01 resolvido (2026-10-15): a 0005 está aplicada em produção;
    toda coluna lida por `require_auth` existe no schema real."""
    _sql, columns = _auth_query_sql()
    assert columns <= set(PRODUCTION_USERS_COLUMNS), sorted(columns - set(PRODUCTION_USERS_COLUMNS))


def _sqlite_with_users(columns_sql: str):
    engine = create_engine("sqlite://", future=True)
    with engine.begin() as conn:
        conn.execute(text(f"CREATE TABLE users ({columns_sql})"))
    return engine


_USERS_0001_SQLITE = (
    "id TEXT PRIMARY KEY, auth_user_id TEXT UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, "
    "active BOOLEAN NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, last_login_at TEXT"
)
_USERS_0005_SQLITE = _USERS_0001_SQLITE + (
    ", version INTEGER NOT NULL DEFAULT 1, sessions_revoked_at TEXT, avatar_object_key TEXT, "
    "deactivated_at TEXT, deactivated_by TEXT"
)
# + colunas da 0019 (exclusão lógica), lidas por `require_auth`.
_USERS_0019_SQLITE = _USERS_0005_SQLITE + (
    ", deleted_at TEXT, deleted_by TEXT, anonymized_at TEXT"
)


@contextmanager
def _db_patched(engine):
    @contextmanager
    def _session():
        session = Session(engine, future=True)
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    with patch("app.auth.supabase_auth.get_db_session", _session), patch(
        "app.api.v1.health.get_db_session", _session
    ):
        yield


def test_sem_a_0005_toda_requisicao_autenticada_vira_500_e_health_segue_200(caplog):
    """PoC com SQL REAL (SQLite, schema `users` da 0001): token válido em
    `/api/v1/me` => 500 genérico (sem SQL/coluna no corpo); o healthcheck
    (`SELECT 1`) continua 200, então o Docker NÃO detecta o problema."""
    engine = _sqlite_with_users(_USERS_0001_SQLITE)
    client = create_app().test_client()
    with _db_patched(engine), caplog.at_level("ERROR"):
        me = client.get("/api/v1/me", headers=_bearer())
        health = client.get("/api/health")

    assert me.status_code == 500
    assert me.get_json() == {"error": {"code": "internal_error", "message": "Erro interno do servidor."}}
    body = me.get_data(as_text=True).lower()
    for leak in ("users.version", "no such column", "select", "sqlite", "operationalerror"):
        assert leak not in body
    assert "no such column: users.version" in caplog.text  # detalhe só no log do servidor
    assert health.status_code == 200 and health.get_json() == {"status": "ok"}


def test_sem_a_0019_toda_requisicao_autenticada_tambem_vira_500(caplog):
    """Mesma classe do PREDEPLOY-01 para a 0019 (exclusão lógica): o SELECT de
    `require_auth` lê `users.deleted_at`. Num banco com a 0005 mas SEM a 0019,
    toda requisição autenticada vira 500 — por isso o espelho
    `sql/0022_user_soft_delete.sql` tem de ser aplicado ANTES de subir a
    imagem nova do backend (o healthcheck não detecta)."""
    engine = _sqlite_with_users(_USERS_0005_SQLITE)
    client = create_app().test_client()
    with _db_patched(engine), caplog.at_level("ERROR"):
        me = client.get("/api/v1/me", headers=_bearer())
        health = client.get("/api/health")
    assert me.status_code == 500
    assert me.get_json() == {
        "error": {"code": "internal_error", "message": "Erro interno do servidor."}
    }
    assert "deleted_at" not in me.get_data(as_text=True)
    assert "no such column: users.deleted_at" in caplog.text
    assert health.status_code == 200


def test_com_a_0005_e_a_0019_aplicadas_a_requisicao_volta_a_401_de_usuario_desconhecido():
    """Controle positivo: com as colunas da 0005 e da 0019, a consulta roda e
    o fluxo normal de autenticação responde 401 (usuário local inexistente)."""
    engine = _sqlite_with_users(_USERS_0019_SQLITE)
    client = create_app().test_client()
    with _db_patched(engine):
        me = client.get("/api/v1/me", headers=_bearer())
    assert me.status_code == 401


# ---------------------------------------------------------------------------
# 2) Sessão: revogação/logout e o access token já emitido (AUD-14-08)
# ---------------------------------------------------------------------------


def _user(**extra: Any) -> SimpleNamespace:
    base = {
        "id": uuid.uuid4(),
        "active": True,
        "auth_user_id": "auth-predeploy-1",
        "name": "Pessoa Sintética",
        "email": "pessoa.sintetica@exemplo.invalid",
        "sessions_revoked_at": None,
    }
    base.update(extra)
    return SimpleNamespace(**base)


@pytest.fixture()
def loader():
    with patch("app.auth.supabase_auth._load_user_with_roles_and_permissions") as mocked:
        yield mocked


def test_revogacao_de_papeis_corta_rotas_administrativas_na_requisicao_seguinte(loader):
    """O que JÁ funciona: papéis/permissões são relidos do banco a cada
    requisição; após `revoke` (papéis removidos), o mesmo JWT recebe 403."""
    client = create_app().test_client()
    loader.return_value = (_user(), set(), set())
    assert client.get("/api/v1/users", headers=_bearer()).status_code == 403
    assert client.get("/api/v1/settings/ai", headers=_bearer()).status_code == 403


def test_usuario_revogado_ainda_le_o_proprio_me_com_o_jwt_antigo(loader):
    """Usuário ativo SEM papéis (ex.: convidado antes da ativação) lê só o
    próprio `/me`. Desde a Etapa 2 o `revoke` também grava `active=false` e
    `sessions_revoked_at` (ver test_user_admin_api), então o caso "revogado"
    real recebe 401; aqui o carregador é simulado."""
    client = create_app().test_client()
    loader.return_value = (_user(), set(), set())
    response = client.get("/api/v1/me", headers=_bearer())
    assert response.status_code == 200
    assert response.get_json()["roles"] == [] and response.get_json()["permissions"] == []


def test_jwt_emitido_antes_de_sessions_revoked_at_e_rejeitado(loader):
    """AUD-14-08 corrigido: require_auth compara `iat` com sessions_revoked_at."""
    client = create_app().test_client()
    revoked_at = datetime.now(timezone.utc)
    loader.return_value = (_user(sessions_revoked_at=revoked_at), {"USER"}, set())
    old_token = _token(iat=int((revoked_at - timedelta(minutes=10)).timestamp()))
    assert client.get("/api/v1/me", headers=_bearer(old_token)).status_code == 401


def test_leeway_tem_teto_de_300_segundos():
    with pytest.raises(ValueError):
        Settings(
            database_url="postgresql://u:p@localhost/x",
            secret_key="s" * 40,
            jwt_leeway_seconds=301,
            _env_file=None,
        )


# ---------------------------------------------------------------------------
# 3) Configuração de produção (PREDEPLOY-04)
# ---------------------------------------------------------------------------


def _prod_kwargs(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "database_url": "postgresql://u:p@db.exemplo.invalid/x",
        "secret_key": "s" * 40,
        "supabase_jwt_secret": "j" * 40,
        "supabase_url": "https://projeto-ficticio.supabase.co",
        "flask_env": "production",
        "cors_allowed_origins": "https://app.example.test",
        "_env_file": None,
    }
    base.update(overrides)
    return base


def test_producao_sem_jwt_secret_falha_fechado_com_401():
    """Sem SUPABASE_JWT_SECRET a API nega tudo (401), não abre."""
    # Sem SUPABASE_URL: nenhuma fonte de chave (nem segredo, nem JWKS derivável).
    custom = Settings(**_prod_kwargs(supabase_jwt_secret=None, supabase_url=None))
    client = create_app().test_client()
    with patch("app.auth.supabase_auth.get_settings", return_value=custom), patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions"
    ) as loader:
        response = client.get("/api/v1/me", headers=_bearer())
    assert response.status_code == 401
    loader.assert_not_called()


def test_sem_supabase_url_nem_issuer_o_iss_nao_e_verificado():
    """Evidência de PREDEPLOY-04: sem SUPABASE_URL/SUPABASE_JWT_ISSUER, `iss`
    deixa de ser exigido (o segredo ainda protege a assinatura)."""
    assert Settings(**_prod_kwargs(supabase_url=None)).supabase_jwt_expected_issuer is None


@pytest.mark.xfail(
    strict=True,
    reason=(
        "PREDEPLOY-04: em produção a aplicação inicia sem nenhuma chave de verificação "
        "de JWT (segredo HS256 ou JWKS) e sem issuer (SUPABASE_URL/SUPABASE_JWT_ISSUER); "
        "deveria recusar a inicialização."
    ),
)
@pytest.mark.parametrize(
    "overrides",
    [
        {"supabase_jwt_secret": None, "supabase_url": None, "supabase_jwks_url": None},
        {"supabase_url": None, "supabase_jwt_issuer": None},
    ],
    ids=["sem_chave_de_verificacao", "sem_issuer"],
)
def test_producao_recusa_iniciar_sem_configuracao_de_jwt(overrides):
    with pytest.raises(ValueError):
        Settings(**_prod_kwargs(**overrides))


# ---------------------------------------------------------------------------
# 4) Celery/Redis e ProxyFix
# ---------------------------------------------------------------------------


def test_celery_so_json_e_apenas_tasks_da_allowlist():
    from app.celery_app import create_celery

    celery = create_celery(Settings(**_prod_kwargs(redis_url="redis://:senha-sintetica@redis:6379/0")))
    assert celery.conf.accept_content == ["json"]
    assert celery.conf.task_serializer == "json" and celery.conf.result_serializer == "json"
    # Beat: só as 3 tasks de insights (Etapa 4b), sem argumentos.
    assert {e["task"] for e in celery.conf.beat_schedule.values()} == {
        "sispat.ai.alerts_priority",
        "sispat.ai.executive_summary",
        "sispat.ai.quality_suggestions",
    }
    celery.loader.import_default_modules()
    proprias = {name for name in celery.tasks if not name.startswith("celery.")}
    assert proprias == {
        "sispat.ai.ping_provider",
        "sispat.ai.alerts_priority",
        "sispat.ai.executive_summary",
        "sispat.ai.quality_suggestions",
    }


def test_nenhuma_rota_http_enfileira_task_celery():
    """Tasks não recebem entrada de usuário: nenhuma view chama delay/apply_async."""
    for path in (BACKEND_DIR / "app" / "api").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        assert not re.search(r"\.(delay|apply_async|send_task)\(", source), path.name


def test_proxyfix_um_hop_usa_o_ultimo_ip_do_x_forwarded_for():
    """Com o Nginx sobrescrevendo X-Forwarded-For ($remote_addr), o IP auditado é
    o do Nginx-resolvido; um valor forjado pelo cliente à esquerda é ignorado.
    Atrás da Cloudflare isso só é o IP REAL do cliente se `set_real_ip_from`
    estiver configurado no vhost (PREDEPLOY-05)."""
    captured: list[dict] = []
    client = create_app().test_client()
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        client.get(
            "/api/v1/me",
            headers={
                "Authorization": "Bearer " + _token(aud="anon"),
                "X-Forwarded-For": "6.6.6.6, 203.0.113.9",
            },
        )
    assert captured and captured[0]["request"]["ip"] == "203.0.113.9"


# ---------------------------------------------------------------------------
# 5) Compose/Dockerfile de produção (estático, sem Docker)
# ---------------------------------------------------------------------------

COMPOSE = (REPO_DIR / "docker-compose.yml").read_text(encoding="utf-8")
BACKEND_DOCKERFILE = (BACKEND_DIR / "Dockerfile").read_text(encoding="utf-8")


def _service_block(name: str) -> str:
    match = re.search(rf"\n  {name}:\n(.*?)(?=\n  [a-z][a-z0-9_-]*:\n|\Z)", COMPOSE, re.S)
    assert match, name
    return match.group(1)


def test_sem_override_de_compose_que_seria_carregado_automaticamente():
    for name in ("docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml",
                 "compose.override.yaml", "compose.yml", "compose.yaml"):
        assert not (REPO_DIR / name).exists(), name


def test_portas_publicadas_somente_em_loopback():
    ports = re.findall(r'^\s+- "([^"]+)"\s*$', COMPOSE, re.M)
    published = [p for p in ports if re.match(r"^[\d.]*:?\$?\{?[A-Z_]*:?-?\d+\}?:\d+$", p)]
    assert published, "nenhuma porta encontrada (regex desatualizada?)"
    for port in published:
        assert port.startswith("127.0.0.1:"), port
    assert "ports:" not in _service_block("redis")
    assert "ports:" not in _service_block("worker")


def test_worker_em_profile_e_redis_com_senha_obrigatoria():
    assert re.search(r"profiles:\s*\n\s+- worker", _service_block("worker"))
    assert "REDIS_PASSWORD=${REDIS_PASSWORD:?" in _service_block("redis")


def test_backend_de_producao_sem_debug_nem_reload():
    backend = _service_block("backend")
    assert "command:" not in backend  # usa o CMD (gunicorn) da imagem
    assert "target: runtime" in backend
    runtime = BACKEND_DOCKERFILE.split("AS runtime", 1)[1]
    assert "FLASK_ENV=production" in runtime and "USER 10001:10001" in runtime
    cmd = runtime.split("CMD", 1)[1]
    for proibido in ("--reload", "--debug", "flask run", "debugpy"):
        assert proibido not in cmd


def test_frontend_nao_recebe_env_file_e_next_public_vai_como_build_arg():
    frontend = _service_block("frontend")
    assert "env_file" not in frontend
    for var in ("NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"):
        assert re.search(rf"args:.*{var}: \$\{{{var}", frontend, re.S), var
    assert not re.search(r"SERVICE_ROLE|SECRET_KEY|JWT_SECRET|N8N_|_API_KEY", frontend)


def test_imagens_externas_fixadas_por_digest():
    for image in re.findall(r"^\s+image: (\S+)$", COMPOSE, re.M):
        if image.startswith("sispat-agu/"):
            continue  # construídas localmente
        assert "@sha256:" in image, image
    for line in re.findall(r"^FROM (\S+)", BACKEND_DOCKERFILE, re.M):
        assert line == "builder" or "@sha256:" in line, line


# ---------------------------------------------------------------------------
# 6) PREDEPLOY-03 — arquivos declarados locais no .gitignore, mas rastreados
# ---------------------------------------------------------------------------


def _git_ls_files() -> list[str] | None:
    git = shutil.which("git")
    if not git or not (REPO_DIR / ".git").exists():
        return None
    out = subprocess.run(  # noqa: S603 - argumentos fixos, sem entrada externa
        [git, "-C", str(REPO_DIR), "ls-files"], capture_output=True, text=True, timeout=30, check=False
    )
    return out.stdout.splitlines() if out.returncode == 0 else None


_LOCAL_ONLY = re.compile(
    r"^(CLAUDE\.md|DESIGN\.md|\.claude/|\.agents/skills/|docs/security/|docs/security-audit/|\.env$)"
)


def test_nenhum_env_ou_chave_rastreado():
    files = _git_ls_files()
    if files is None:
        pytest.skip("git indisponível")
    for path in files:
        name = path.rsplit("/", 1)[-1]
        assert not re.match(r"^\.env(\..+)?$", name) or name == ".env.example", path
        assert not re.search(r"\.(pem|key|p12|pfx)$|credentials.*\.json$", name), path


@pytest.mark.xfail(
    strict=True,
    reason=(
        "PREDEPLOY-03: .gitignore declara docs/security-audit/ e .claude como locais, "
        "mas relatorio-auditoria-seguranca.pdf, generate_report.py e .claude/* seguem "
        "rastreados (já enviados ao remoto). Corrigir com git rm --cached."
    ),
)
def test_arquivos_declarados_locais_nao_estao_rastreados():
    files = _git_ls_files()
    if files is None:
        pytest.skip("git indisponível")
    tracked_local = [path for path in files if _LOCAL_ONLY.match(path)]
    assert tracked_local == []


# ---------------------------------------------------------------------------
# 7) AUD-14-09 — JWKS (código em andamento): com cache expirado e o endpoint
#    fora do ar, CADA requisição refaz a busca (timeout) segurando o lock global.
# ---------------------------------------------------------------------------


def _jwks_settings() -> SimpleNamespace:
    return SimpleNamespace(
        supabase_jwks_effective_url="https://projeto-ficticio.supabase.co/auth/v1/.well-known/jwks.json",
        is_production=True,
        supabase_jwks_cache_seconds=600,
        supabase_jwks_timeout_seconds=3.0,
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "AUD-14-09: com cache JWKS vencido (mas utilizável) e o endpoint indisponível, "
        "não há backoff: cada requisição faz nova busca com timeout sob lock global."
    ),
)
def test_jwks_indisponivel_com_cache_vencido_aplica_backoff():
    jwks = pytest.importorskip("app.auth.jwks")
    clock = {"now": 1000.0}
    fake_time = SimpleNamespace(monotonic=lambda: clock["now"])
    calls = {"n": 0}
    sentinel_key = object()

    def fetch_ok(url, timeout):
        calls["n"] += 1
        return {"kid-1": sentinel_key}

    def fetch_down(url, timeout):
        calls["n"] += 1
        raise jwks.JwksUnavailableError("timeout simulado")

    jwks.reset_jwks_cache()
    try:
        with patch.object(jwks, "time", fake_time), patch.object(jwks, "_fetch_jwks", fetch_ok):
            assert jwks.get_signing_key("kid-1", _jwks_settings()) is sentinel_key
        calls["n"] = 0
        clock["now"] += 601  # TTL vencido, ainda dentro de 6x TTL (cache "stale" utilizável)
        with patch.object(jwks, "time", fake_time), patch.object(jwks, "_fetch_jwks", fetch_down):
            for _ in range(5):
                assert jwks.get_signing_key("kid-1", _jwks_settings()) is sentinel_key
                clock["now"] += 0.1
        assert calls["n"] <= 1, f"{calls['n']} buscas ao JWKS em 0,5 s com o endpoint fora do ar"
    finally:
        jwks.reset_jwks_cache()
