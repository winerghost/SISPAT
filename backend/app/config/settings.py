"""Configurações da aplicação, carregadas exclusivamente via variáveis de ambiente.

Nenhuma credencial ou segredo possui valor padrão hardcoded neste módulo.
Em desenvolvimento, as variáveis podem ser definidas em um arquivo `.env`
(não versionado) na raiz de `backend/`; em produção, devem ser fornecidas
pelo ambiente de execução (ex.: variáveis de ambiente do container).

Variáveis de ambiente suportadas:
    DATABASE_URL            URL de conexão SQLAlchemy/psycopg2 para o Postgres
                            (ex.: postgresql+psycopg2://user:pass@host:5432/db)
    DB_POOL_SIZE            Tamanho do pool de conexões (default: 5)
    DB_MAX_OVERFLOW         Conexões extras permitidas além do pool (default: 10)
    DB_ECHO                 Se "true", loga todas as queries SQL (default: false)
    FLASK_ENV               "development" | "production" | "testing"
    SECRET_KEY              Chave secreta usada pela aplicação Flask
    REDIS_URL               URL de conexão com o Redis (cache/fila)
    CELERY_BROKER_URL       URL do broker Celery (default: usa REDIS_URL)
    CELERY_RESULT_BACKEND   URL do result backend Celery (default: usa REDIS_URL)
    SUPABASE_URL            URL do projeto Supabase (autenticação externa)
    SUPABASE_SERVICE_ROLE_KEY  Chave service_role do Supabase (uso apenas no backend)
    SUPABASE_JWT_SECRET     Segredo HS256 legado usado para verificar os JWTs emitidos
                            pelo Supabase Auth (Project Settings > API > JWT Settings).
                            Ver limitação documentada em `app.auth.supabase_auth` sobre
                            projetos que usam JWKS/RS256 em vez deste segredo simétrico.
    SUPABASE_JWT_AUDIENCE   Valor exigido no claim `aud` dos JWTs (default: "authenticated").
    SUPABASE_JWT_ISSUER     Valor exigido no claim `iss`. Se ausente e SUPABASE_URL estiver
                            definida, usa "<SUPABASE_URL>/auth/v1" (padrão do GoTrue).
    JWT_LEEWAY_SECONDS      Tolerância de relógio (s) na validação de `exp`/`iat` (default: 30).
    MAX_CONTENT_LENGTH_BYTES  Tamanho máximo do corpo das requisições (default: 1 MiB).
    CORS_ALLOWED_ORIGINS    Lista de origens permitidas para CORS, separadas por vírgula
                            (ex.: "https://app.exemplo.com,http://localhost:3000").
    TRUSTED_PROXY_IPS       Lista de IPs de proxy reverso confiável(eis), separados por
                            vírgula (ex.: "127.0.0.1"). Documenta o(s) IP(s) esperado(s)
                            do CloudPanel/Nginx; ver limitação do ProxyFix em `app/__init__.py`.
    N8N_INTEGRATION_ENABLED  Feature flag da integração com o n8n externo (default: false)
    N8N_BASE_URL            URL base da instância n8n externa (ex.: https://n8n.exemplo.com)
    N8N_WEBHOOK_URL         URL específica de webhook do n8n (tem prioridade sobre N8N_BASE_URL)
    N8N_API_KEY             Credencial usada no header Authorization ao chamar o n8n
                            (nunca logada pela aplicação)
    N8N_REQUEST_TIMEOUT_SECONDS  Timeout (segundos) das requisições HTTP ao n8n (default: 10)
    GOOGLE_SHEETS_CREDENTIALS_JSON  Caminho do arquivo de credenciais (service account) usado
                            por `app.integrations.google_sheets_client.GoogleSheetsClient`.
    GOOGLE_SHEETS_SPREADSHEET_ID    ID da planilha Google Sheets de origem do acervo patrimonial.
    GOOGLE_SHEETS_SHEET_NAME    Título exato da aba a ser lida (tem prioridade sobre
                            GOOGLE_SHEETS_SHEET_GID). Opcional; ver limitação documentada em
                            `app.integrations.google_sheets_client` sobre a aba usada quando
                            nenhum dos dois estiver configurado.
    GOOGLE_SHEETS_SHEET_GID     GID (sheetId numérico) da aba a ser lida, usado quando
                            GOOGLE_SHEETS_SHEET_NAME não estiver configurado. Opcional.
    IMPORT_PREVIEW_TTL_MINUTES  Minutos de validade de uma pré-visualização de importação
                            (`app.services.import_service.ImportService.create_preview`) antes
                            de expirar e não poder mais ser confirmada (default: 60).
    INVITE_ALLOWED_REDIRECT_URLS  Lista de URLs de redirecionamento pós-convite
                            PREVIAMENTE AUTORIZADAS, separadas por vírgula (ex.:
                            "https://app.exemplo.com/convite/aceitar"). Usada por
                            `app.integrations.supabase_admin_client.SupabaseAdminClient.
                            invite_user_by_email` para rejeitar, sem chamar a API Admin
                            do Supabase, qualquer `redirect_to` que não esteja nesta
                            lista (proteção contra redirecionamento não autorizado).
                            A PRIMEIRA URL desta lista é também usada por
                            `app.services.invite_service.InviteService.create_invite`
                            como a URL de ativação de convite configurada (ver
                            docstring daquele módulo).
    INVITE_TTL_DAYS         Dias de validade do REGISTRO LOCAL de um convite
                            (`app.services.invite_service.InviteService.create_invite`)
                            antes de expirar e não poder mais ser aceito (default: 7).
    AI_ENABLED              Chave geral da IA consultiva (default: false). Quando false,
                            VENCE qualquer configuração do banco (`ai_settings`): toda
                            chamada vira NullProvider, sem rede.
    OPENAI_API_KEY          Chave da API OpenAI. SEGREDO: só no ambiente do backend;
                            nunca em banco, resposta da API, log ou frontend.
    ANTHROPIC_API_KEY       Chave da API Anthropic. SEGREDO (mesmas regras).
    DEEPSEEK_API_KEY        Chave da API DeepSeek. SEGREDO (mesmas regras). O uso do
                            DeepSeek exige aceite explícito do ADM (transferência
                            internacional de dados, LGPD).
    AI_TIMEOUT_SECONDS      Timeout (s) de cada chamada HTTP ao provedor (default: 20).
    AI_MAX_TOKENS           Máximo de tokens de saída por chamada (default: 800).
    AI_RATE_LIMIT_PER_USER  Chamadas de IA por usuário por hora (default: 20).
    AI_RATE_LIMIT_PER_UNIT  Chamadas de IA por unidade por hora (default: 100).
    AI_MONTHLY_TOKEN_CAP    Teto global de tokens/mês (default: 200000). O teto efetivo é
                            o MENOR entre este valor e `ai_settings.monthly_token_cap`.
    AI_CIRCUIT_FAILURE_THRESHOLD  Falhas consecutivas que abrem o circuito (default: 3).
    AI_CIRCUIT_OPEN_SECONDS Tempo (s) com o circuito aberto -> NullProvider (default: 300).
    WORKER_CPUS / WORKER_MEMORY  Limites do container worker (lidos só pelo
                            docker-compose; não usados por este módulo).
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Tamanho mínimo de segredos simétricos exigido em produção (256 bits em
# caracteres ASCII; o segredo JWT legado do Supabase tem 40+ caracteres).
_MIN_SECRET_LENGTH = 32


class Settings(BaseSettings):
    """Configurações centrais do backend SISPAT-AGU."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Banco de dados ---
    database_url: str = Field(
        ...,
        description="URL de conexão SQLAlchemy/psycopg2 para o Postgres (Supabase).",
    )
    db_pool_size: int = Field(default=5, ge=1)
    db_max_overflow: int = Field(default=10, ge=0)
    db_echo: bool = Field(default=False)

    # --- Aplicação Flask ---
    flask_env: str = Field(default="production")
    secret_key: str = Field(
        ...,
        description="Chave secreta da aplicação Flask (sessions, CSRF, etc.).",
    )

    # --- Redis / Celery ---
    redis_url: str = Field(default="redis://localhost:6379/0")
    celery_broker_url: str | None = Field(default=None)
    celery_result_backend: str | None = Field(default=None)

    # --- Supabase (autenticação externa) ---
    supabase_url: str | None = Field(default=None)
    supabase_service_role_key: str | None = Field(default=None)
    supabase_jwt_secret: str | None = Field(
        default=None,
        description=(
            "Segredo HS256 legado do Supabase Auth, usado por "
            "`app.auth.supabase_auth` para verificar a assinatura dos JWTs. "
            "Se o projeto Supabase usar JWKS/RS256, este campo não se aplica "
            "(pendência documentada, ver docstring de `supabase_auth`)."
        ),
    )

    supabase_jwt_audience: str = Field(
        default="authenticated",
        description="Valor exigido no claim `aud` dos JWTs do Supabase Auth.",
    )
    supabase_jwt_issuer: str | None = Field(
        default=None,
        description=(
            "Valor exigido no claim `iss`. Se ausente, é derivado de SUPABASE_URL "
            "(`<SUPABASE_URL>/auth/v1`) quando esta estiver configurada."
        ),
    )
    jwt_leeway_seconds: int = Field(default=30, ge=0, le=300)

    # --- Limites de requisição ---
    max_content_length_bytes: int = Field(default=1_048_576, ge=1024)

    # --- CORS / Reverse proxy (CloudPanel) ---
    cors_allowed_origins: str = Field(
        default="http://localhost:3000",
        description="Origens permitidas para CORS, separadas por vírgula.",
    )
    trusted_proxy_ips: str = Field(
        default="127.0.0.1",
        description=(
            "IP(s) de proxy reverso confiável(eis), separados por vírgula. "
            "Documentação operacional do(s) IP(s) esperado(s) (CloudPanel/"
            "Nginx); ver limitação do ProxyFix padrão em `app/__init__.py` "
            "quanto à ausência de filtragem por IP de origem."
        ),
    )

    # --- n8n (automação externa via webhooks, instância fora deste projeto) ---
    n8n_integration_enabled: bool = Field(
        default=False,
        description="Feature flag: se False, o cliente n8n não faz nenhuma chamada de rede.",
    )
    n8n_base_url: str | None = Field(
        default=None,
        description="URL base da instância n8n externa (ex.: https://n8n.exemplo.com).",
    )
    n8n_webhook_url: str | None = Field(
        default=None,
        description="URL de webhook específica do n8n; usada com prioridade sobre n8n_base_url.",
    )
    n8n_api_key: str | None = Field(
        default=None,
        description="Credencial enviada no header Authorization ao chamar o n8n. Nunca é logada.",
    )
    n8n_request_timeout_seconds: int = Field(default=10, ge=1)

    # --- Google Sheets (origem somente leitura da sincronização/importação) ---
    # Nomes escolhidos para corresponder exatamente ao que
    # `app.integrations.google_sheets_client.GoogleSheetsClient` já lê via
    # `getattr(settings, "google_sheets_*", None)` (ver docstring daquele
    # módulo) — qualquer alteração de nome aqui deve ser replicada lá.
    google_sheets_credentials_json: str | None = Field(
        default=None,
        description=(
            "Caminho do arquivo de credenciais (service account) usado para "
            "autenticar na Google Sheets API."
        ),
    )
    google_sheets_spreadsheet_id: str | None = Field(
        default=None,
        description="ID da planilha Google Sheets de origem do acervo patrimonial.",
    )
    google_sheets_sheet_name: str | None = Field(
        default=None,
        description=(
            "Título exato da aba a ser lida; tem prioridade sobre "
            "google_sheets_sheet_gid. Opcional (ver limitação documentada em "
            "app.integrations.google_sheets_client)."
        ),
    )
    google_sheets_sheet_gid: str | None = Field(
        default=None,
        description=(
            "GID (sheetId numérico) da aba a ser lida, usado quando "
            "google_sheets_sheet_name não estiver configurado. Opcional."
        ),
    )
    google_sheets_timeout_seconds: int | None = Field(
        default=None,
        ge=1,
        le=300,
        description="Timeout (s) das requisições à Google Sheets API (padrão do cliente se ausente).",
    )

    # --- TLS do Postgres (lidos por `app.database.session`; declarados aqui
    # para documentação/validação centralizada) ---
    db_sslmode: str | None = Field(default=None, description="DB_SSLMODE (ex.: verify-full).")
    db_sslrootcert: str | None = Field(default=None, description="DB_SSLROOTCERT (caminho da CA).")

    # --- Supabase Admin API (convites, gestão de MFA/usuários) ---
    invite_allowed_redirect_urls: str = Field(
        default="",
        description=(
            "Lista de URLs de redirecionamento pós-convite PREVIAMENTE "
            "AUTORIZADAS, separadas por vírgula. Ver "
            "`app.integrations.supabase_admin_client.SupabaseAdminClient."
            "invite_user_by_email`."
        ),
    )

    invite_ttl_days: int = Field(
        default=7,
        ge=1,
        description=(
            "Dias de validade do registro local de um convite "
            "(app.services.invite_service.InviteService.create_invite) antes "
            "de expirar e não poder mais ser aceito."
        ),
    )

    # --- Importação de dados (pré-visualização/confirmação) ---
    import_preview_ttl_minutes: int = Field(
        default=60,
        ge=1,
        description=(
            "Minutos de validade de uma pré-visualização de importação "
            "(app.services.import_service.ImportService.create_preview) antes "
            "de expirar e não poder mais ser confirmada."
        ),
    )

    # --- IA consultiva (app.services.ai). Chaves: repr=False para nunca
    # aparecerem em repr()/logs do objeto Settings. ---
    ai_enabled: bool = Field(
        default=False,
        description="Chave geral da IA; False vence qualquer configuração do banco.",
    )
    openai_api_key: str | None = Field(default=None, repr=False)
    anthropic_api_key: str | None = Field(default=None, repr=False)
    deepseek_api_key: str | None = Field(default=None, repr=False)
    ai_timeout_seconds: int = Field(default=20, ge=1, le=120)
    ai_max_tokens: int = Field(default=800, ge=1, le=8000)
    ai_rate_limit_per_user: int = Field(default=20, ge=1, description="Chamadas/hora por usuário.")
    ai_rate_limit_per_unit: int = Field(default=100, ge=1, description="Chamadas/hora por unidade.")
    ai_monthly_token_cap: int = Field(default=200_000, ge=0, le=50_000_000)
    ai_circuit_failure_threshold: int = Field(default=3, ge=1, le=100)
    ai_circuit_open_seconds: int = Field(default=300, ge=10, le=86_400)

    @model_validator(mode="after")
    def _apply_celery_defaults(self) -> "Settings":
        """Usa REDIS_URL como padrão do Celery quando não configurado explicitamente."""
        if self.celery_broker_url is None:
            self.celery_broker_url = self.redis_url
        if self.celery_result_backend is None:
            self.celery_result_backend = self.redis_url
        return self

    @model_validator(mode="after")
    def _enforce_production_secrets(self) -> "Settings":
        """Em produção, recusa segredos curtos/vazios (falha na inicialização).

        HS256 com segredo curto é passível de força bruta offline; SECRET_KEY
        vazia/curta enfraquece qualquer assinatura feita pelo Flask.
        """
        if self.flask_env.lower() == "production":
            if self.db_echo:
                raise ValueError(
                    "DB_ECHO não é permitido em produção (registraria SQL e parâmetros nos logs)."
                )
            if len(self.secret_key or "") < _MIN_SECRET_LENGTH:
                raise ValueError(
                    f"SECRET_KEY deve ter ao menos {_MIN_SECRET_LENGTH} caracteres em produção."
                )
            if self.supabase_jwt_secret is not None and len(self.supabase_jwt_secret) < _MIN_SECRET_LENGTH:
                raise ValueError(
                    f"SUPABASE_JWT_SECRET deve ter ao menos {_MIN_SECRET_LENGTH} caracteres em produção."
                )
        return self

    @property
    def supabase_jwt_expected_issuer(self) -> str | None:
        """Issuer esperado nos JWTs: explícito, ou derivado de SUPABASE_URL."""
        if self.supabase_jwt_issuer:
            return self.supabase_jwt_issuer.strip()
        if self.supabase_url:
            return f"{self.supabase_url.strip().rstrip('/')}/auth/v1"
        return None

    @property
    def is_production(self) -> bool:
        return self.flask_env.lower() == "production"

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        """Parseia `cors_allowed_origins` (string separada por vírgula) em uma lista."""
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def trusted_proxy_ips_list(self) -> list[str]:
        """Parseia `trusted_proxy_ips` (string separada por vírgula) em uma lista."""
        return [ip.strip() for ip in self.trusted_proxy_ips.split(",") if ip.strip()]

    @property
    def invite_allowed_redirect_urls_list(self) -> list[str]:
        """Parseia `invite_allowed_redirect_urls` (string separada por vírgula) em uma lista."""
        return [
            url.strip() for url in self.invite_allowed_redirect_urls.split(",") if url.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    """Retorna uma instância cacheada de `Settings`, lida uma única vez do ambiente."""
    return Settings()
