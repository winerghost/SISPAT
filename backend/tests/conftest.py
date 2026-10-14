"""Configuração compartilhada dos testes do backend SISPAT-AGU.

Define variáveis de ambiente mínimas e FICTÍCIAS antes de qualquer módulo
da aplicação ser importado pelos testes. Isso é necessário porque
`app.config.settings.get_settings()` é cacheada (`functools.lru_cache`) e
lê `DATABASE_URL`/`SECRET_KEY` (campos obrigatórios, sem default) do
ambiente/arquivo `.env` na primeira chamada — sem isso, qualquer teste que
importe `app` (ex.: `from app import create_app`) falharia na validação do
Pydantic. Nenhum destes valores aponta para um banco de dados ou segredo
real; `os.environ.setdefault` nunca sobrescreve um valor já definido no
ambiente (ex.: em CI).
"""
from __future__ import annotations

import os

_FICTICIOS = {
    "DATABASE_URL": "postgresql+psycopg2://user:pass@localhost:5432/test",
    "SECRET_KEY": "test-secret-key-sintetica-com-32-bytes-ou-mais",
    "SUPABASE_JWT_SECRET": "test-jwt-secret-sintetico-com-32-bytes-ou-mais",
    "CORS_ALLOWED_ORIGINS": "http://localhost:3000",
    "TRUSTED_PROXY_IPS": "127.0.0.1",
    "FLASK_ENV": "testing",
}
_REMOVER = (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_AUDIENCE",
    "SUPABASE_JWT_ISSUER", "REDIS_URL", "CELERY_BROKER_URL", "CELERY_RESULT_BACKEND",
    "N8N_INTEGRATION_ENABLED", "N8N_BASE_URL", "N8N_WEBHOOK_URL", "N8N_API_KEY",
    "N8N_REQUEST_TIMEOUT_SECONDS", "GOOGLE_SHEETS_CREDENTIALS_JSON",
    "GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_SHEET_NAME",
    "GOOGLE_SHEETS_SHEET_GID", "GOOGLE_SHEETS_TIMEOUT_SECONDS",
    "DB_SSLMODE", "DB_SSLROOTCERT", "DB_ECHO", "INVITE_ALLOWED_REDIRECT_URLS",
    "AI_ENABLED", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY",
)
for _name in _REMOVER:
    os.environ.pop(_name, None)
os.environ.update(_FICTICIOS)

# Nunca ler `backend/.env` (relativo ao cwd) durante os testes; só afeta o
# processo pytest, sem alterar o comportamento de produção.
from app.config.settings import Settings  # noqa: E402

Settings.model_config["env_file"] = None

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _sem_escritor_de_auditoria_em_segundo_plano(monkeypatch):
    """Impede que eventos de segurança sejam gravados por thread em background.

    Causa raiz de AUD-14-04: a thread daemon global criada por um teste
    anterior gravava depois, tocando `SessionLocal` mockado do teste seguinte.
    Testes que verificam eventos continuam usando seu próprio patch de
    `_dispatch` (que prevalece sobre este).
    """
    monkeypatch.setattr("app.authorization.security_events._dispatch", lambda event: None)
