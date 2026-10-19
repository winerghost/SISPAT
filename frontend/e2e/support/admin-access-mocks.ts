// =============================================================================
// Mocks sintéticos de `GET /api/v1/admin/roles` e `/admin/permissions`
// (contrato: backend/app/services/admin_access_service.py). Dados fictícios:
// 40 permissões para ADM, 11 para USER e 6 para RH (proporção do banco real).
// =============================================================================

export interface AccessPermissionMock {
  code: string;
  description: string;
  resource: string;
  action: string;
}

export interface AccessRoleMock {
  code: string;
  name: string;
  description: string;
  active: boolean;
  permissions: AccessPermissionMock[];
  active_users_count: number;
}

export interface AdminAccessMock {
  roles: AccessRoleMock[];
  permissions: (AccessPermissionMock & { roles: string[] })[];
}

const RESOURCES = ["assets", "units", "rooms", "people", "movements", "inventories", "users", "audit"] as const;
const ACTIONS = ["read", "create", "update", "delete", "export"] as const;

const ALL: AccessPermissionMock[] = RESOURCES.flatMap((resource) =>
  ACTIONS.map((action) => ({
    code: `${resource}.${action}`,
    description: `Permite ${action} em ${resource} (sintético)`,
    resource,
    action,
  })),
);

const USER_CODES = new Set([
  "assets.read",
  "assets.create",
  "assets.update",
  "units.read",
  "rooms.read",
  "people.read",
  "movements.read",
  "movements.create",
  "movements.update",
  "inventories.read",
  "inventories.update",
]);
const RH_CODES = new Set([
  "assets.read",
  "units.read",
  "rooms.read",
  "people.read",
  "movements.read",
  "inventories.read",
]);

export function defaultAdminAccess(): AdminAccessMock {
  const byRole: Record<string, AccessPermissionMock[]> = {
    ADM: ALL,
    USER: ALL.filter((p) => USER_CODES.has(p.code)),
    RH: ALL.filter((p) => RH_CODES.has(p.code)),
  };
  return {
    roles: [
      {
        code: "ADM",
        name: "Administrador",
        description: "Administra usuários, cadastros e configurações.",
        active: true,
        permissions: byRole.ADM!,
        active_users_count: 3,
      },
      {
        code: "USER",
        name: "Usuário",
        description: "Opera o patrimônio nas unidades atribuídas.",
        active: true,
        permissions: byRole.USER!,
        active_users_count: 12,
      },
      {
        code: "RH",
        name: "Recursos Humanos",
        description: "Consulta patrimônio para fins de gestão de pessoas.",
        active: true,
        permissions: byRole.RH!,
        active_users_count: 2,
      },
    ],
    permissions: ALL.map((p) => ({
      ...p,
      roles: ["ADM", "USER", "RH"].filter((r) => byRole[r]!.some((q) => q.code === p.code)),
    })),
  };
}
