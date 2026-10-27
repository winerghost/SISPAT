"""Pacote de modelos ORM do SISPAT-AGU.

Importar este pacote garante que todas as classes mapeadas sejam
registradas no metadata de `Base`, necessário para o Alembic (autogenerate
e `target_metadata`) e para eventuais usos de `Base.metadata.create_all`
em testes.

Nota de design sobre `relationship()`:
    Relações de posse/hierarquia claras (unit -> rooms/locations/responsible_people,
    role <-> permission, user <-> role, asset -> movements, inventory -> items,
    sync_job -> raw_import_records) são bidirecionais (`back_populates`).
    Colunas que são apenas referências de "ator" em trilhas de auditoria
    (ex.: `created_by`, `updated_by`, `deleted_by`, `approved_by`,
    `checked_by`, `assigned_by`, `resolved_by`, `requested_by`) são
    modeladas como `relationship` unidirecional (sem `back_populates` em
    `User`), pois não representam uma coleção útil de navegação a partir do
    usuário nesta fase.
"""
from app.database.session import Base  # noqa: F401

from app.models.rbac import Permission, Role, RolePermission, User, UserRole  # noqa: F401,E402
from app.models.units import Location, Room, Unit, UnitAlias, UserUnitAccess  # noqa: F401,E402
from app.models.people import ResponsiblePerson  # noqa: F401,E402
from app.models.assets import Asset, AssetMovement  # noqa: F401,E402
from app.models.inventory import Inventory, InventoryItem  # noqa: F401,E402
from app.models.audit import AuditLog  # noqa: F401,E402
from app.models.sync import RawImportRecord, SyncConflict, SyncJob  # noqa: F401,E402
from app.models.misc import ExportJob, SavedFilter  # noqa: F401,E402
from app.models.imports import ImportPreview, ImportPreviewItem  # noqa: F401,E402
from app.models.invites import Invite, InviteUnit  # noqa: F401,E402
from app.models.settings import (  # noqa: F401,E402
    AISettings,
    UserDashboardPreferences,
    UserPreferences,
)

__all__ = [
    "Base",
    "User",
    "Role",
    "Permission",
    "RolePermission",
    "UserRole",
    "Unit",
    "UnitAlias",
    "UserUnitAccess",
    "Room",
    "Location",
    "ResponsiblePerson",
    "Asset",
    "AssetMovement",
    "Inventory",
    "InventoryItem",
    "AuditLog",
    "SyncJob",
    "SyncConflict",
    "RawImportRecord",
    "SavedFilter",
    "ExportJob",
    "ImportPreview",
    "ImportPreviewItem",
    "Invite",
    "InviteUnit",
    "AISettings",
    "UserPreferences",
    "UserDashboardPreferences",
]
