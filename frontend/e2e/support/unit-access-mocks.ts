// =============================================================================
// Mock sintético de `GET /api/v1/admin/unit-access` (contrato:
// backend/app/api/v1/admin_schemas.py::UnitAccessQuery e
// backend/app/services/admin_access_service.py). Dados fictícios: 30 usuários (padrão; `count` gera mais)
//, sem e-mail/telefone, como o backend.
// =============================================================================

import { mockPage, mockPageSize } from "./page-size";

export interface UnitAccessItemMock {
  user_id: string;
  name: string;
  role: "ADM" | "USER" | "RH" | null;
  active: boolean;
  units: { id: string; code: string }[];
}

const UNIT_A = { id: "60000000-0000-4000-8000-000000000001", code: "PSU-TO" };
const UNIT_B = { id: "60000000-0000-4000-8000-000000000002", code: "ESC-02" };
const UNIT_C = { id: "60000000-0000-4000-8000-000000000003", code: "NUC-03" };

export const UNIT_ACCESS_XSS_NAME = `<img src=x onerror="window.__xss=1"> Vinculado`;

export function defaultUnitAccess(count = 30): UnitAccessItemMock[] {
  const roles = ["USER", "RH", "ADM"] as const;
  const combos = [[UNIT_A], [UNIT_B], [UNIT_A, UNIT_B], [UNIT_C], [UNIT_A, UNIT_B, UNIT_C]];
  const items: UnitAccessItemMock[] = Array.from({ length: count }, (_, i) => ({
    user_id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name: `Pessoa Vinculada ${String(i + 1).padStart(2, "0")}`,
    role: roles[i % 3]!,
    active: i % 7 !== 6,
    units: combos[i % combos.length]!,
  }));
  items[0] = { ...items[0]!, name: UNIT_ACCESS_XSS_NAME };
  return items;
}

const ALLOWED = new Set(["unit_id", "role", "active", "sort", "page", "page_size"]);

/** Aplica a query como o backend: `null` = 400 (parâmetro desconhecido/inválido). */
export function queryUnitAccess(items: UnitAccessItemMock[], params: URLSearchParams) {
  for (const key of params.keys()) if (!ALLOWED.has(key)) return null;
  const role = params.get("role");
  const active = params.get("active");
  const unit = params.get("unit_id");
  const sort = params.get("sort") ?? "name";
  const page = mockPage(params);
  const pageSize = mockPageSize(params);
  if (role && !["ADM", "USER", "RH"].includes(role)) return null;
  if (active && !["true", "false"].includes(active)) return null;
  if (!["name", "-name"].includes(sort)) return null;
  if (page === null || pageSize === null) return null;
  const dir = sort === "-name" ? -1 : 1;
  const list = items
    .filter(
      (u) =>
        (!role || u.role === role) &&
        (!active || String(u.active) === active) &&
        (!unit || u.units.some((x) => x.id === unit)),
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "pt-BR") * dir);
  return {
    total: list.length,
    page,
    page_size: pageSize,
    items: list.slice((page - 1) * pageSize, page * pageSize),
  };
}
