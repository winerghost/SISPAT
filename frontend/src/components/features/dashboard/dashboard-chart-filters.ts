// =============================================================================
// Gráfico → filtro da URL (clique numa barra/fatia ou nos botões acessíveis).
// =============================================================================
// Funções PURAS: dado o item do gráfico, devolvem o "patch" de filtros
// equivalente ou `null` quando não existe filtro equivalente (ex.: "Outros",
// "Outras", unidade cuja sigla não identifica UMA unidade acessível). Valores
// passam pela MESMA sanitização da URL (`sanitizeDashboardFilters`): o que não
// sobreviveria a ela não vira filtro. A validação real (400) e o escopo são do
// backend — isto só decide se há ação no clique.
//
// `null` no patch = remover aquela chave (ex.: escolher uma sala tira o
// "Sem sala" e vice-versa). Clicar de novo num item já aplicado REMOVE o
// filtro (alternância, com `aria-pressed` nos botões).
// =============================================================================

import {
  BOND_NONE,
  sanitizeDashboardFilters,
  type DashboardFilterKey,
  type DashboardFilters,
  type LocatedFilterValue,
} from "@/lib/dashboard-api";

export type FilterPatch = Partial<Record<DashboardFilterKey, string | null>>;

/** Patch só com valores que passam na sanitização da URL; senão `null`. */
function cleanPatch(patch: FilterPatch): FilterPatch | null {
  const values = Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === "string"));
  const clean = sanitizeDashboardFilters(values) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(values)) {
    if (clean[key] !== value) return null;
  }
  return Object.keys(values).length > 0 ? patch : null;
}

/** O patch (parte com valor) já está aplicado nos filtros atuais. */
export function isPatchApplied(filters: DashboardFilters, patch: FilterPatch | null): boolean {
  if (!patch) return false;
  const current = filters as Record<string, string | undefined>;
  const entries = Object.entries(patch).filter(([, v]) => typeof v === "string");
  return entries.length > 0 && entries.every(([key, value]) => current[key] === value);
}

/** Aplica (ou, se já aplicado, remove) o patch sobre os filtros. */
export function togglePatch(filters: DashboardFilters, patch: FilterPatch): DashboardFilters {
  const active = isPatchApplied(filters, patch);
  const next: Record<string, string | undefined> = { ...filters };
  for (const [key, value] of Object.entries(patch)) {
    if (active || value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as DashboardFilters;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

/** Situação ("Localizado", "Não localizado", "Desconhecido") → `located`. */
export function locatedFromSituation(id: string): LocatedFilterValue | null {
  switch (normalize(id)) {
    case "LOCALIZADO":
    case "SIM":
      return "SIM";
    case "NAO_LOCALIZADO":
    case "NAO":
      return "NAO";
    case "DESCONHECIDO":
      return "DESCONHECIDO";
    default:
      return null;
  }
}

export function situationFilter(id: string): FilterPatch | null {
  const located = locatedFromSituation(id);
  return located ? { located } : null;
}

/** Série do gráfico de localização por unidade (sim/nao/desconhecido). */
export function locationSeriesFilter(seriesKey: string): FilterPatch | null {
  const map: Record<string, LocatedFilterValue> = { sim: "SIM", nao: "NAO", desconhecido: "DESCONHECIDO" };
  const located = map[seriesKey];
  return located ? { located } : null;
}

const BOND_OTHERS = "__outros__";

/** Vínculo: `id` = grafia usável em `bond_status`; "Sem vínculo" = `__none__`; "Outros" sem ação. */
export function bondFilter(id: string): FilterPatch | null {
  if (id === BOND_OTHERS) return null;
  if (id === BOND_NONE) return { bond_status: BOND_NONE };
  return cleanPatch({ bond_status: id });
}

const ROOM_OTHERS = "__outras__";
const ROOM_NONE = "__none__";

/** Sala: UUID → `room_id`; "Sem sala" → `has_room=false`; "Outras" sem ação. */
export function roomFilter(id: string): FilterPatch | null {
  if (id === ROOM_OTHERS) return null;
  if (id === ROOM_NONE) return { has_room: "false", room_id: null };
  return cleanPatch({ room_id: id, has_room: null });
}

export interface UnitRefLike {
  id: string;
  code: string;
}

/** Agregado "Outras" do backend (soma das unidades além do top 15). */
const UNIT_OTHERS = "Outras";

/**
 * Unidade do gráfico → `unit_id`. Usa o `unit_id` da linha quando o backend o
 * envia; senão, a sigla precisa casar com o código de EXATAMENTE UMA unidade
 * acessível ao usuário (nada de adivinhar entre homônimas).
 */
export function unitFilter(
  row: { unidade: string; unit_id?: string },
  units: readonly UnitRefLike[] | undefined,
): FilterPatch | null {
  if (row.unit_id) return cleanPatch({ unit_id: row.unit_id });
  const label = row.unidade.trim();
  if (!label || label === UNIT_OTHERS || !units) return null;
  const key = label.toLocaleUpperCase("pt-BR");
  const matches = units.filter((unit) => unit.code.trim().toLocaleUpperCase("pt-BR") === key);
  return matches.length === 1 ? cleanPatch({ unit_id: matches[0]!.id }) : null;
}

/** Combina patches (ex.: unidade + localizado de um segmento empilhado). */
export function mergePatches(...patches: (FilterPatch | null)[]): FilterPatch | null {
  const parts = patches.filter((p): p is FilterPatch => !!p);
  return parts.length > 0 ? Object.assign({}, ...parts) : null;
}
