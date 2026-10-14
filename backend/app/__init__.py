"""Pacote principal da aplicação backend do SISPAT-AGU.

Contém a fábrica da aplicação Flask (`create_app`), além da fundação de
banco de dados (configuração, sessão SQLAlchemy e modelos ORM) já existente
desde a Fase 1.
"""
from __future__ import annotations

import logging
import uuid

from flask import Flask, g, request
from werkzeug.middleware.proxy_fix import ProxyFix

from app.api.v1 import api_v1_bp
from app.api.v1.health import health_legacy_bp
from app.config.settings import get_settings
from app.errors import register_error_handlers

logger = logging.getLogger(__name__)

# Métodos usados pela API (GET/POST/PATCH/DELETE; PUT reservado ao avatar) + preflight.
_CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"

# Cabeçalhos de segurança aplicados a TODAS as respostas da API (JSON).
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

_REQUEST_ID_MAX_LEN = 64


def _configure_security_headers(app: Flask) -> None:
    """Aplica cabeçalhos de segurança, `Cache-Control` e `X-Request-ID`.

    - Cabeçalhos fixos (`_SECURITY_HEADERS`): a API só serve JSON, então a
      CSP é `default-src 'none'` e o enquadramento é proibido.
    - `Cache-Control: no-store` em TODAS as respostas da API (autenticadas
      ou de erro), para que proxies/navegadores não guardem dados
      patrimoniais/pessoais. O healthcheck também recebe `no-store`.
    - HSTS é responsabilidade do Cloudflare/CloudPanel (TLS termina lá);
      ainda assim é enviado quando a requisição chegou como HTTPS.
    - `X-Request-ID`: gerado por requisição (nunca aceito do cliente, para
      não permitir injeção em logs/auditoria) e devolvido na resposta.
    """

    @app.before_request
    def _assign_request_id():
        g.request_id = uuid.uuid4().hex

    @app.after_request
    def _apply_security_headers(response):
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        if request.is_secure:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        request_id = getattr(g, "request_id", None)
        if request_id:
            response.headers["X-Request-ID"] = str(request_id)[:_REQUEST_ID_MAX_LEN]
        return response


def _configure_cors(app: Flask, allowed_origins: list[str]) -> None:
    """Configura CORS restrito a `allowed_origins`.

    Implementação manual (sem depender de uma extensão de terceiros) para
    manter controle explícito: nenhuma origem fora da lista recebe os
    cabeçalhos `Access-Control-Allow-*`, e requisições de preflight
    (`OPTIONS`) de origens não permitidas recebem apenas a resposta padrão
    do Flask, sem cabeçalhos de CORS.
    """
    allowed = set(allowed_origins)

    @app.before_request
    def _handle_cors_preflight():
        if request.method != "OPTIONS":
            return None
        origin = request.headers.get("Origin")
        if origin and origin in allowed:
            # Resposta padrão de preflight do Flask (lista os métodos
            # permitidos na rota correspondente); os cabeçalhos de CORS em
            # si são adicionados pelo `after_request` abaixo.
            return app.make_default_options_response()
        return None

    @app.after_request
    def _apply_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin and origin in allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            # Sem `Access-Control-Allow-Credentials`: a API autentica por
            # `Authorization: Bearer` (o frontend usa `credentials: "omit"`),
            # nunca por cookie — habilitar credenciais só ampliaria a
            # superfície (CSRF/credenciais ambientes) sem nenhum benefício.
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response.headers["Access-Control-Allow-Methods"] = _CORS_ALLOWED_METHODS
            response.headers["Access-Control-Expose-Headers"] = "X-Request-ID"
            response.headers["Access-Control-Max-Age"] = "600"
            # Garante que caches/CDNs intermediários não reutilizem esta
            # resposta para uma Origin diferente.
            existing_vary = response.headers.get("Vary")
            response.headers["Vary"] = f"{existing_vary}, Origin" if existing_vary else "Origin"
        return response


def create_app() -> Flask:
    """Cria e configura a instância da aplicação Flask do SISPAT-AGU.

    Compatível com os comandos já referenciados em
    `docker-compose.dev.yml`/`Dockerfile`:
        - `flask --app app:create_app run ...` (desenvolvimento)
        - `gunicorn ... "app:create_app()"` (produção)
    """
    settings = get_settings()

    app = Flask(__name__)
    app.config["SECRET_KEY"] = settings.secret_key
    # Limite de tamanho do corpo (413 padronizado em `app.errors`).
    app.config["MAX_CONTENT_LENGTH"] = settings.max_content_length_bytes
    # Nunca propagar exceções para o servidor WSGI (evita páginas de debug).
    app.config["PROPAGATE_EXCEPTIONS"] = False

    # --- Reverse proxy (CloudPanel/Nginx) ---
    # `ProxyFix` faz a aplicação confiar nos cabeçalhos `X-Forwarded-For`,
    # `X-Forwarded-Proto` e `X-Forwarded-Host` enviados por exatamente 1
    # "hop" de proxy reverso (x_for=1, x_proto=1, x_host=1), assumindo o
    # CloudPanel/Nginx como único proxy diante desta aplicação (ver
    # docker-compose.yml e infra/cloudpanel/vhost.conf.example).
    #
    # LIMITAÇÃO CONHECIDA: o `ProxyFix` padrão do Werkzeug NÃO valida que
    # esses cabeçalhos realmente vieram de um IP listado em
    # `settings.trusted_proxy_ips` — ele apenas confia incondicionalmente
    # nos últimos N valores da cadeia (N = parâmetros `x_for`/`x_proto`/
    # `x_host` configurados abaixo), de quem quer que tenha falado
    # diretamente com o processo Flask. Ou seja, se um cliente conseguisse
    # contornar o proxy confiável e falar diretamente com esta aplicação,
    # poderia falsificar esses cabeçalhos (ex.: para forjar o IP de origem
    # em logs de auditoria, ou simular HTTPS).
    #
    # A mitigação real desta limitação deve ocorrer na camada de
    # rede/infraestrutura, reforçada no nginx/CloudPanel, não no `ProxyFix`
    # em si:
    #   (1) a porta do backend é publicada apenas em 127.0.0.1 (ver
    #       docker-compose.yml), inacessível externamente sem passar pelo
    #       CloudPanel;
    #   (2) o vhost do CloudPanel/Nginx
    #       (infra/cloudpanel/vhost.conf.example) deve ser o único ponto de
    #       entrada público, garantindo que todo tráfego que chega a esta
    #       aplicação já passou por aquele proxy confiável.
    # `settings.trusted_proxy_ips` é mantida na configuração como
    # documentação operacional do(s) IP(s) esperado(s) do proxy e para uso
    # futuro caso se introduza validação adicional por IP de origem (ex.:
    # um middleware que rejeite conexões cujo peer não esteja nessa
    # lista); esta fase não implementa tal filtro.
    logger.info(
        "ProxyFix ativo (1 hop); IPs de proxy confiável esperados (documentação/"
        "uso futuro, não aplicados por filtro de IP nesta fase): %s",
        settings.trusted_proxy_ips_list,
    )
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]

    _configure_security_headers(app)
    _configure_cors(app, settings.cors_allowed_origins_list)

    register_error_handlers(app)

    app.register_blueprint(api_v1_bp)
    app.register_blueprint(health_legacy_bp)

    return app
