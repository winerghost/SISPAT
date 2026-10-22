// =============================================================================
// SISPAT-AGU — unit-access-api.ts
// =============================================================================
// Tipos, parse defensivo da URL e chamada SOMENTE LEITURA de
// `GET /api/v1/admin/unit-access` (ADM + AAL2 + `users.manage`). Só transporte
// e allowlist de parâmetros: o backend valida (extra="forbid"), aplica o escopo
// de unidade e decide tudo. A edição de perfil/unidades de um usuário é do
// `PATCH /api/v1/users/<id>` (tela Usuários) — nada de escrita aqui.
// =============================================================================

import { apiClient } from "@/lib/api-client";
import { DEFAULT_PAGE_SIZE, parsePageSize, type PageSize } from "@/lib/pagination";
import type { UserRole } from "@/lib/users-api";

export interface UnitAccessUnit {
  id: string;
  code: string;
}

export interface UnitAccessItem {
  user_id: string;
  name: string;
  role: UserRole | null;
  active: boolean;
  /** Só unidades do escopo do ADM consultante. */
  units: UnitAccessUnit[];
}

export interface UnitAccessResponse {
  total: number;
  page: number;
  page_size: number;
  items: UnitAccessItem[];
}

export type UnitAccessSort = "name" | "-name";
export type UnitAccessActive = "true" | "false";

export interface UnitAccessFilters {
  unit_id?: string;
  role?: UserRole;
  active?: UnitAccessActive;
  sort: UnitAccessSort;
  page: number;
  /** Backend aceita só 50, 100 ou 200. */
  page_size: PageSize;
}

const MAX_PAGE = 100_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly UserRole[] = ["ADM", "USER", "RH"];
const ALLOWED_KEYS = new Set(["unit_id", "role", "active", "sort", "page", "page_size"]);

/**
 * Lê os filtros da URL: chave desconhecida/repetida ou valor inválido é
 * descartado (a tela nunca quebra e nunca envia lixo ao backend).
 */
export function parseUnitAccessFilters(params: URLSearchParams): UnitAccessFilters {
  const one = (key: string): string | undefined => {
    const all = params.getAll(key);
    return ALLOWED_KEYS.has(key) && all.length === 1 ? all[0] : undefined;
  };
  const unit = one("unit_id");
  const role = one("role");
  const active = one("active");
  const sort = one("sort");
  const page = one("page");
  const pageNumber = page && /^\d{1,6}$/.test(page) ? Number(page) : 1;
  return {
    unit_id: unit && UUID_RE.test(unit) ? unit.toLowerCase() : undefined,
    role: role && (ROLES as readonly string[]).includes(role) ? (role as UserRole) : undefined,
    active: active === "true" || active === "false" ? active : undefined,
    sort: sort === "-name" ? "-name" : "name",
    page: pageNumber >= 1 && pageNumber <= MAX_PAGE ? pageNumber : 1,
    page_size: parsePageSize(one("page_size")),
  };
}

/** Query canônica (omite o que é padrão). */
export function unitAccessQueryString(filters: UnitAccessFilters): string {
  const out = new URLSearchParams();
  if (filters.unit_id) out.set("unit_id", filters.unit_id);
  if (filters.role) out.set("role", filters.role);
  if (filters.active) out.set("active", filters.active);
  if (filters.sort !== "name") out.set("sort", filters.sort);
  if (filters.page > 1) out.set("page", String(filters.page));
  if (filters.page_size !== DEFAULT_PAGE_SIZE) out.set("page_size", String(parsePageSize(filters.page_size)));
  return out.toString();
}

/** `GET /api/v1/admin/unit-access`. */
export function getUnitAccess(filters: UnitAccessFilters): Promise<UnitAccessResponse> {
  return apiClient.get<UnitAccessResponse>("/v1/admin/unit-access", {
    searchParams: {
      unit_id: filters.unit_id,
      role: filters.role,
      active: filters.active,
      sort: filters.sort,
      page: filters.page,
      page_size: parsePageSize(filters.page_size),
    },
  });
}
