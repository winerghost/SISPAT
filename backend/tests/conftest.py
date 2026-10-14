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

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://user:pass@localhost:5432/test")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret-sintetico-com-32-bytes-ou-mais")
os.environ.setdefault("CORS_ALLOWED_ORIGINS", "http://localhost:3000")
os.environ.setdefault("TRUSTED_PROXY_IPS", "127.0.0.1")
os.environ.setdefault("FLASK_ENV", "testing")
