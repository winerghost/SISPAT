"""Versão 1 da API REST do SISPAT-AGU (`/api/v1`).

Este pacote reúne os blueprints de todos os recursos da versão 1 da API em
`api_v1_bp`. Novos recursos (ex.: endpoints de importação, implementados em
outra frente de trabalho) devem registrar seus próprios blueprints aqui,
dentro de `api_v1_bp`, para herdar automaticamente o prefixo `/api/v1`.
"""
from __future__ import annotations

from flask import Blueprint

from app.api.v1.health import health_bp
from app.api.v1.imports import imports_bp
from app.api.v1.me import me_bp
from app.api.v1.security import security_bp
from app.api.v1.users import users_bp

api_v1_bp = Blueprint("api_v1", __name__, url_prefix="/api/v1")
api_v1_bp.register_blueprint(health_bp)
api_v1_bp.register_blueprint(imports_bp)
api_v1_bp.register_blueprint(me_bp)
api_v1_bp.register_blueprint(security_bp)
api_v1_bp.register_blueprint(users_bp)

__all__ = ["api_v1_bp"]
