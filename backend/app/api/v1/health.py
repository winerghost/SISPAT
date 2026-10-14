"""Healthcheck da API do SISPAT-AGU.

Expõe `GET /api/v1/health` (dentro do blueprint versionado `api_v1_bp`) e,
por compatibilidade com o endpoint já referenciado no `docker-compose.yml`
e no `Dockerfile` (`GET /api/health`), também `GET /api/health` — ambos
executam exatamente a mesma verificação, sem exigir autenticação.

A verificação testa a conectividade básica com o banco (`SELECT 1`) e
retorna 503 se ela falhar, sem expor nenhum detalhe interno do erro ao
cliente (o detalhe real é logado no servidor).
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify
from sqlalchemy import text

from app.database.session import get_db_session

logger = logging.getLogger(__name__)

# Blueprint versionado — registrado dentro de `api_v1_bp` (ver
# `app/api/v1/__init__.py`), resultando em `GET /api/v1/health`.
health_bp = Blueprint("health", __name__)

# Blueprint de compatibilidade legada — registrado diretamente em
# `create_app()` (ver `app/__init__.py`), resultando em `GET /api/health`,
# o caminho referenciado pelo HEALTHCHECK do Dockerfile/docker-compose.yml.
health_legacy_bp = Blueprint("health_legacy", __name__, url_prefix="/api")


def _check_health():
    """Executa a verificação de conectividade e retorna a resposta Flask apropriada."""
    try:
        with get_db_session() as db:
            db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - qualquer falha de conectividade vira 503
        logger.error(
            "Healthcheck falhou: banco de dados inacessível (%s: %s).",
            exc.__class__.__name__,
            exc,
        )
        return (
            jsonify(
                {
                    "error": {
                        "code": "service_unavailable",
                        "message": "Serviço indisponível (banco de dados inacessível).",
                    }
                }
            ),
            503,
        )
    return jsonify({"status": "ok"}), 200


@health_bp.route("/health", methods=["GET"])
def health_v1():
    return _check_health()


@health_legacy_bp.route("/health", methods=["GET"])
def health_legacy():
    return _check_health()
