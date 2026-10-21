"""Versão 1 da API REST do SISPAT-AGU (`/api/v1`).

Este pacote reúne os blueprints de todos os recursos da versão 1 da API em
`api_v1_bp`. Novos recursos (ex.: endpoints de importação, implementados em
outra frente de trabalho) devem registrar seus próprios blueprints aqui,
dentro de `api_v1_bp`, para herdar automaticamente o prefixo `/api/v1`.
"""
from __future__ import annotations

from flask import Blueprint

from app.api.v1.admin_access import admin_access_bp
from app.api.v1.admin_audit import admin_audit_bp
from app.api.v1.ai import ai_bp
from app.api.v1.ai_settings import ai_settings_bp
from app.api.v1.assets import assets_bp
from app.api.v1.catalog_imports import catalog_imports_bp
from app.api.v1.dashboard import dashboard_bp
from app.api.v1.email_settings import email_settings_bp
from app.api.v1.health import health_bp
from app.api.v1.imports import imports_bp
from app.api.v1.inventories import inventories_bp
from app.api.v1.locations import locations_bp
from app.api.v1.me import me_bp
from app.api.v1.movements import movements_bp
from app.api.v1.reports import reports_bp
from app.api.v1.responsible_people import responsible_people_bp
from app.api.v1.rooms import rooms_bp
from app.api.v1.security import security_bp
from app.api.v1.units import units_bp
from app.api.v1.users import users_bp

api_v1_bp = Blueprint("api_v1", __name__, url_prefix="/api/v1")
api_v1_bp.register_blueprint(admin_access_bp)
api_v1_bp.register_blueprint(admin_audit_bp)
api_v1_bp.register_blueprint(ai_bp)
api_v1_bp.register_blueprint(ai_settings_bp)
api_v1_bp.register_blueprint(assets_bp)
api_v1_bp.register_blueprint(catalog_imports_bp)
api_v1_bp.register_blueprint(dashboard_bp)
api_v1_bp.register_blueprint(email_settings_bp)
api_v1_bp.register_blueprint(health_bp)
api_v1_bp.register_blueprint(imports_bp)
api_v1_bp.register_blueprint(inventories_bp)
api_v1_bp.register_blueprint(locations_bp)
api_v1_bp.register_blueprint(me_bp)
api_v1_bp.register_blueprint(movements_bp)
api_v1_bp.register_blueprint(reports_bp)
api_v1_bp.register_blueprint(responsible_people_bp)
api_v1_bp.register_blueprint(rooms_bp)
api_v1_bp.register_blueprint(security_bp)
api_v1_bp.register_blueprint(units_bp)
api_v1_bp.register_blueprint(users_bp)

__all__ = ["api_v1_bp"]
