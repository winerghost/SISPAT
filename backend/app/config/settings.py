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
    CELERY_BEAT_SCHEDULE_FILENAME  Caminho ABSOLUTO do arquivo de estado do beat
                            (default: /tmp/celerybeat-schedule, tmpfs privado do
                            container read_only do worker).
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
    PASSWORD_RESET_REDIRECT_URL  URL da tela do frontend que recebe o link de
                            recuperação de senha enviado pelo Supabase
                            (`POST /api/v1/users/<id>/password-reset`). Precisa
                            estar TAMBÉM em INVITE_ALLOWED_REDIRECT_URLS (mesma
                            allow-list); vazia => usa a PRIMEIRA URL daquela lista.
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
    ALERTS_UNCHECKED_DAYS, ALERTS_NO_MOVEMENT_DAYS  Limites (dias) dos alertas (default: 365).
    ALERTS_PATRIMONY_REGEX  Formato aceito do número patrimonial (alerta "fora do padrão").
    ALERTS_SPIKE_BASELINE_WEEKS, ALERTS_SPIKE_SIGMA, ALERTS_SPIKE_MIN_COUNT  Picos de
                            movimentações (defaults: 8 semanas, 3.0 sigma, mínimo 5).
    EMAIL_ENABLED           Chave geral do envio de e-mail SMTP (default: false). Quando false,
                            `app.services.email` usa NullEmailSender (nao envia, nao falha).
    EMAIL_HOST / EMAIL_PORT Servidor SMTP e porta (587 STARTTLS ou 465 SSL; 25 recusada).
    EMAIL_USER              Usuario SMTP.
    EMAIL_PASSWORD          SEGREDO (SecretStr). Senha de app do Gmail: espacos removidos.
    EMAIL_FROM              Remetente (endereco unico; nunca vem do cliente).
    EMAIL_FROM_NAME         Nome de exibicao opcional do remetente.
    EMAIL_SECURITY          "starttls" (default, porta 587) ou "ssl" (porta 465).
    EMAIL_TIMEOUT_SECONDS   Timeout (s) das operacoes SMTP (default: 10; faixa 1-60).
    EMAIL_ALLOWED_RECIPIENT_DOMAINS  Dominios de destinatario permitidos (CSV; vazio = todos).
    EMAIL_MAX_PER_HOUR      Teto global de e-mails por hora (default: 30).
    WORKER_CPUS / WORKER_MEMORY  Limites do container worker (lidos só pelo
                            docker-compose; não usados por este módulo).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import PurePosixPath, PureWindowsPath

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.services.email.address import (
    InvalidAddressError,
    has_control_chars,
    is_valid_hostname,
    parse_single_address,
)

# Tamanho mínimo de segredos simétricos exigido em produção (256 bits em
# caracteres ASCII; o segredo JWT legado do Supabase tem 40+ caracteres).
_MIN_SECRET_LENGTH = 32
_ALLOWED_JWT_ALGORITHMS = frozenset({"HS256", "ES256"})
_EMAIL_SECURITY_MODES = frozenset({"starttls", "ssl"})
_EMAIL_ALLOWED_PORTS = frozenset({465, 587})


class Settings(BaseSettings):
    """Configurações centrais do backend SISPAT-AGU."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Banco de dados ---
    # AI-CFG-01: todo campo que é (ou pode conter) segredo usa repr=False,
    # para nunca aparecer em repr()/str() do Settings (logs, tracebacks com
    # variáveis locais, Sentry). Os consumidores leem o atributo normalmente.
    database_url: str = Field(
        ...,
        repr=False,
        description="URL de conexão SQLAlchemy/psycopg2 para o Postgres (Supabase).",
    )
    db_pool_size: int = Field(default=5, ge=1)
    db_max_overflow: int = Field(default=10, ge=0)
    db_echo: bool = Field(default=False)

    # --- Aplicação Flask ---
    flask_env: str = Field(default="production")
    secret_key: str = Field(
        ...,
        repr=False,
        description="Chave secreta da aplicação Flask (sessions, CSRF, etc.).",
    )

    # --- Redis / Celery ---
    # URLs do Redis/Celery contêm a senha do Redis (redis://:<senha>@host).
    redis_url: str = Field(default="redis://localhost:6379/0", repr=False)
    celery_broker_url: str | None = Field(default=None, repr=False)
    celery_result_backend: str | None = Field(default=None, repr=False)
    # AI-SAST-01: arquivo de estado do beat. Padrão no tmpfs PRIVADO do
    # container do worker (read_only: true + tmpfs /tmp próprio do serviço,
    # docker-compose.yml), onde nenhum outro processo pode pré-criar o
    # arquivo; fora do container, defina um diretório do próprio app.
    celery_beat_schedule_filename: str = Field(
        default="/tmp/celerybeat-schedule",  # nosec B108
        min_length=2,
        max_length=255,
    )

    # --- Supabase (autenticação externa) ---
    supabase_url: str | None = Field(default=None)
    supabase_service_role_key: str | None = Field(default=None, repr=False)
    supabase_jwt_secret: str | None = Field(
        default=None,
        repr=False,
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
    supabase_jwt_algorithms: str = Field(
        default="HS256,ES256",
        description=(
            "Algoritmos JWT aceitos (allowlist: HS256, ES256). HS256 exige "
            "SUPABASE_JWT_SECRET; ES256 usa o JWKS do projeto. Para desligar "
            "o segredo legado, defina apenas ES256."
        ),
    )
    supabase_jwks_url: str | None = Field(
        default=None,
        description=(
            "Override do JWKS. Padrão: <SUPABASE_URL>/auth/v1/.well-known/jwks.json "
            "(HTTPS obrigatório em produção)."
        ),
    )
    supabase_jwks_cache_seconds: int = Field(default=600, ge=30, le=86_400)
    supabase_jwks_timeout_seconds: float = Field(default=3.0, gt=0, le=10)

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
        repr=False,  # URLs de webhook costumam carregar um token no caminho
        description="URL de webhook específica do n8n; usada com prioridade sobre n8n_base_url.",
    )
    n8n_api_key: str | None = Field(
        default=None,
        repr=False,
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
        repr=False,
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
    # Abas dos CADASTROS de apoio (importação de unidades/salas/pessoas). Cada
    # aba é localizada por nome exato (prioridade) OU GID; todas opcionais —
    # sem configuração, a importação do cadastro correspondente recusa rodar.
    google_sheets_units_sheet_name: str | None = Field(default=None, description="Aba de Unidades (nome exato).")
    google_sheets_units_sheet_gid: str | None = Field(default=None, description="Aba de Unidades (GID).")
    google_sheets_rooms_sheet_name: str | None = Field(default=None, description="Aba de Salas (nome exato).")
    google_sheets_rooms_sheet_gid: str | None = Field(default=None, description="Aba de Salas (GID).")
    google_sheets_people_sheet_name: str | None = Field(default=None, description="Aba de Pessoas (nome exato).")
    google_sheets_people_sheet_gid: str | None = Field(default=None, description="Aba de Pessoas (GID).")
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

    password_reset_redirect_url: str | None = Field(
        default=None,
        description=(
            "URL de destino do e-mail de recuperação de senha; precisa estar em "
            "INVITE_ALLOWED_REDIRECT_URLS (vazia => primeira URL daquela lista)."
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

    # --- Alertas determinísticos (app.services.alerts; Etapa 4a). Só limites
    # de regras; nenhum segredo. ---
    alerts_unchecked_days: int = Field(
        default=365, ge=1, le=3650, description="Dias sem conferência (checked_at) para alertar."
    )
    alerts_no_movement_days: int = Field(
        default=365, ge=1, le=3650, description="Dias sem movimentação para alertar."
    )
    alerts_patrimony_regex: str = Field(
        default=r"^[0-9A-Za-z][0-9A-Za-z./-]{0,31}$",
        max_length=200,
        description="Regex (POSIX/PostgreSQL) do formato aceito do número patrimonial.",
    )
    alerts_spike_baseline_weeks: int = Field(
        default=8, ge=4, le=52, description="Semanas anteriores usadas como linha de base."
    )
    alerts_spike_sigma: float = Field(default=3.0, ge=1.0, le=10.0)
    alerts_spike_min_count: int = Field(
        default=5, ge=1, le=100_000, description="Mínimo de movimentos na semana para haver pico."
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

    # --- E-mail SMTP (app.services.email). DESLIGADO por padrao. A senha e
    # SecretStr (fora de repr/dump/logs); o cliente NUNCA fornece o remetente. ---
    email_enabled: bool = Field(default=False)
    email_host: str | None = Field(default=None)
    email_port: int = Field(default=587, ge=1, le=65535)
    email_user: str | None = Field(default=None, repr=False)
    email_password: SecretStr | None = Field(default=None, repr=False, exclude=True)
    email_from: str | None = Field(default=None)
    email_from_name: str | None = Field(default=None, max_length=100)
    email_security: str = Field(default="starttls")
    email_timeout_seconds: int = Field(default=10, ge=1, le=60)
    email_allowed_recipient_domains: str = Field(default="")
    email_max_per_hour: int = Field(default=30, ge=1, le=1000)

    @field_validator(
        "email_host", "email_user", "email_password", "email_from", "email_from_name",
        mode="before",
    )
    @classmethod
    def _email_blank_to_none(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("email_port", "email_timeout_seconds", "email_max_per_hour", mode="before")
    @classmethod
    def _email_blank_int_to_default(cls, value, info):
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator("email_password", mode="before")
    @classmethod
    def _email_password_strip_spaces(cls, value):
        # O Gmail exibe a senha de app em 4 grupos separados por espaco.
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if isinstance(value, str):
            value = "".join(value.split()) or None
        return value

    @field_validator("email_security", mode="before")
    @classmethod
    def _email_security_allowlist(cls, value):
        normalized = str(value).strip().lower() if value is not None else "starttls"
        if normalized not in _EMAIL_SECURITY_MODES:
            raise ValueError("EMAIL_SECURITY deve ser 'starttls' ou 'ssl'.")
        return normalized

    @model_validator(mode="after")
    def _validate_email(self) -> "Settings":
        """Quando EMAIL_ENABLED=true exige configuracao completa e TLS verificado.

        Desligado, nada e validado (o ambiente atual continua subindo).
        """
        if not self.email_enabled:
            return self
        missing = [
            name for name, val in (
                ("EMAIL_HOST", self.email_host), ("EMAIL_USER", self.email_user),
                ("EMAIL_PASSWORD", self.email_password), ("EMAIL_FROM", self.email_from),
            ) if not val
        ]
        if missing:
            raise ValueError(f"EMAIL_ENABLED=true exige: {', '.join(missing)}.")
        if not is_valid_hostname(self.email_host or ""):
            raise ValueError("EMAIL_HOST invalido.")
        if self.email_port not in _EMAIL_ALLOWED_PORTS:
            raise ValueError("EMAIL_PORT deve ser 587 (STARTTLS) ou 465 (SSL); texto claro/25 recusado.")
        expected = "ssl" if self.email_port == 465 else "starttls"
        if self.email_security != expected:
            raise ValueError(f"EMAIL_PORT={self.email_port} exige EMAIL_SECURITY={expected}.")
        try:
            self.email_from = parse_single_address(self.email_from)
        except InvalidAddressError:
            raise ValueError("EMAIL_FROM deve ser um unico endereco de e-mail valido.") from None
        if self.email_from_name and has_control_chars(self.email_from_name):
            raise ValueError("EMAIL_FROM_NAME contem caracteres de controle.")
        for domain in self.email_allowed_recipient_domains_list:
            if not is_valid_hostname(domain):
                raise ValueError("EMAIL_ALLOWED_RECIPIENT_DOMAINS contem dominio invalido.")
        # Producao: TLS (starttls/ssl) e certificado verificado sao incondicionais
        # (o modulo usa ssl.create_default_context() e nao ha opcao de desativar).
        return self

    @property
    def email_allowed_recipient_domains_list(self) -> list[str]:
        return [
            d.strip().lower() for d in self.email_allowed_recipient_domains.split(",") if d.strip()
        ]

    @model_validator(mode="after")
    def _apply_celery_defaults(self) -> "Settings":
        """Usa REDIS_URL como padrão do Celery quando não configurado explicitamente."""
        if self.celery_broker_url is None:
            self.celery_broker_url = self.redis_url
        if self.celery_result_backend is None:
            self.celery_result_backend = self.redis_url
        return self

    @model_validator(mode="after")
    def _validate_beat_schedule_filename(self) -> "Settings":
        """Caminho absoluto, sem `..` nem caracteres de controle."""
        path = self.celery_beat_schedule_filename
        absolute = PurePosixPath(path).is_absolute() or PureWindowsPath(path).is_absolute()
        parts = path.replace("\\", "/").split("/")
        if not absolute or ".." in parts or any(ord(c) < 32 for c in path):
            raise ValueError("CELERY_BEAT_SCHEDULE_FILENAME deve ser um caminho absoluto, sem '..'.")
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
            # Regra: o segredo HS256 só é exigido/validado se HS256 estiver
            # habilitado; com SUPABASE_JWT_ALGORITHMS=ES256 ele é ignorado.
            if (
                "HS256" in self.supabase_jwt_algorithms_list
                and self.supabase_jwt_secret is not None
                and len(self.supabase_jwt_secret) < _MIN_SECRET_LENGTH
            ):
                raise ValueError(
                    f"SUPABASE_JWT_SECRET deve ter ao menos {_MIN_SECRET_LENGTH} caracteres em produção."
                )
            # M1/M2: origens CORS e redirects de convite só em HTTPS em produção
            # (localhost/http continuam válidos fora de produção).
            for name, items in (
                ("CORS_ALLOWED_ORIGINS", self.cors_allowed_origins_list),
                ("INVITE_ALLOWED_REDIRECT_URLS", self.invite_allowed_redirect_urls_list),
            ):
                if any(not item.lower().startswith("https://") for item in items):
                    raise ValueError(f"{name} deve conter apenas URLs https:// em produção.")
        return self

    @model_validator(mode="after")
    def _validate_jwt_algorithms(self) -> "Settings":
        """Allowlist {HS256, ES256}; ES256 sem URL de JWKS derivável é erro."""
        algs = self.supabase_jwt_algorithms_list
        if not algs or any(a not in _ALLOWED_JWT_ALGORITHMS for a in algs):
            raise ValueError("SUPABASE_JWT_ALGORITHMS deve conter apenas HS256 e/ou ES256.")
        return self

    @property
    def supabase_jwt_algorithms_list(self) -> list[str]:
        return [a.strip().upper() for a in self.supabase_jwt_algorithms.split(",") if a.strip()]

    @property
    def supabase_jwks_effective_url(self) -> str | None:
        if self.supabase_jwks_url:
            return self.supabase_jwks_url.strip()
        if self.supabase_url:
            return f"{self.supabase_url.strip().rstrip('/')}/auth/v1/.well-known/jwks.json"
        return None

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

    @property
    def password_reset_redirect_effective_url(self) -> str | None:
        """URL de recuperação de senha SE estiver na allow-list; senão a 1ª da lista."""
        allowed = self.invite_allowed_redirect_urls_list
        configured = (self.password_reset_redirect_url or "").strip()
        if configured:
            return configured if configured in allowed else None
        return allowed[0] if allowed else None


@lru_cache
def get_settings() -> Settings:
    """Retorna uma instância cacheada de `Settings`, lida uma única vez do ambiente."""
    return Settings()
