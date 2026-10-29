// =============================================================================
// Mocks SINTÉTICOS de `GET /api/v1/reports` e `GET /api/v1/reports/<kind>/export`
// (contrato: docs/architecture/reports-api.md; catálogo espelha
// backend/app/services/report_catalog.py, inclusive os tipos de LOOKUP
// `room`/`person` e as opções dinâmicas de `bond_status` do contrato de
// 2026-10-28). Dados fictícios. Imita as regras que
// a UI precisa explicar: ADM sem AAL2 => 403 AAL2_REQUIRED; RH sem colunas de
// texto livre; `include_deleted` só ADM (senão 403); parâmetro não declarado =>
// 400; unidade/inventário alheios ou malformados => 404; `q=limite` => 413
// row_limit_exceeded; `q=vazio` => arquivo só com cabeçalho. A autoridade real
// continua sendo o backend.
// =============================================================================

import type { Route } from "@playwright/test";

export interface ReportsMockState {
  /** Status forçado no catálogo (ex.: 500, 403). */
  catalogStatus: number | null;
  /** Status forçado na exportação (ex.: 429, 500, 403). */
  exportStatus: number | null;
  /** `Retry-After` (s) enviado junto com o 429 forçado. */
  retryAfter: number;
  exportDelayMs: number;
  /** Quantidade de linhas de dados do arquivo gerado. */
  rows: number;
  /**
   * Catálogo no contrato ANTIGO: `room_id`/`responsible_person_id` como `uuid`
   * e `bond_status` como `text` livre (sem opções). Serve para provar que a
   * tela degrada para campo livre enquanto o backend não anuncia os lookups.
   */
  legacyFilterTypes: boolean;
  /** Substitui as opções de `bond_status` (dinâmicas por usuário; `[]` = sem unidade). */
  bondStatusOptions: string[] | null;
}

export function defaultReportsState(partial: Partial<ReportsMockState> = {}): ReportsMockState {
  return {
    catalogStatus: null,
    exportStatus: null,
    retryAfter: 90,
    exportDelayMs: 0,
    rows: 3,
    legacyFilterTypes: false,
    bondStatusOptions: null,
    ...partial,
  };
}

interface ReportsHandlerState {
  role: "ADM" | "USER" | "RH";
  aal: "aal1" | "aal2";
  reports: ReportsMockState;
  unitDetails: Record<string, { id: string }>;
  inventories: { id: string }[];
  rooms: { id: string }[];
  people: { id: string }[];
}

interface Col {
  key: string;
  label: string;
  internal?: boolean;
}
interface Def {
  id: string;
  title: string;
  description: string;
  columns: Col[];
  filters: { name: string; type: string; options?: string[]; max_length?: number }[];
  sorts: string[];
  default_sort: string;
}

const MOVEMENT_STATUS = ["PENDENTE", "APROVADA", "REJEITADA", "CONCLUIDA", "CANCELADA"];

/**
 * Opções de `bond_status` como o backend as manda (contrato de 2026-10-28):
 * valores DISTINTOS existentes no escopo de unidade do ator (vêm da planilha,
 * não são um enum fixo), em ordem alfabética, com a sentinela `__none__`
 * ("Sem vínculo") no FIM e só quando existe bem sem vínculo. Usuário sem
 * unidade recebe `[]` (lista vazia legítima, não falha).
 */
export const BOND_STATUS_OPTIONS = ["Estagiario", "Ocioso", "Servidor", "Terceirizado", "__none__"];

const DEFS: Def[] = [
  {
    id: "assets",
    title: "Patrimônios",
    description: "Bens patrimoniais visíveis nas suas unidades.",
    columns: [
      { key: "patrimony_number", label: "Nº patrimonial" },
      { key: "description", label: "Descrição" },
      { key: "bond_status", label: "Vínculo" },
      { key: "unit_code", label: "Unidade (código)" },
      { key: "responsible", label: "Responsável" },
      { key: "created_at", label: "Criado em (UTC)" },
      { key: "notes", label: "Observações", internal: true },
    ],
    filters: [
      { name: "q", type: "text", max_length: 100 },
      { name: "unit_id", type: "unit" },
      { name: "owner_unit_id", type: "unit" },
      { name: "room_id", type: "room" },
      { name: "responsible_person_id", type: "person" },
      { name: "located", type: "enum", options: ["SIM", "NAO", "DESCONHECIDO"] },
      { name: "bond_status", type: "enum", options: BOND_STATUS_OPTIONS, max_length: 64 },
    ],
    sorts: ["patrimony_number", "-patrimony_number", "description", "-description", "created_at", "-created_at"],
    default_sort: "patrimony_number",
  },
  {
    id: "movements",
    title: "Movimentações",
    description: "Histórico de movimentações de bens com origem ou destino nas suas unidades.",
    columns: [
      { key: "patrimony_number", label: "Nº patrimonial" },
      { key: "movement_type", label: "Tipo" },
      { key: "status", label: "Situação" },
      { key: "created_at", label: "Solicitada em (UTC)" },
      { key: "reason", label: "Motivo", internal: true },
    ],
    filters: [
      { name: "status", type: "enum", options: MOVEMENT_STATUS },
      { name: "movement_type", type: "enum", options: ["TRANSFERENCIA_UNIDADE", "MUDANCA_SALA", "TROCA_RESPONSAVEL"] },
      { name: "origin_unit_id", type: "unit" },
      { name: "destination_unit_id", type: "unit" },
      { name: "created_from", type: "date" },
      { name: "created_to", type: "date" },
    ],
    sorts: ["created_at", "-created_at", "status", "-status"],
    default_sort: "-created_at",
  },
  {
    id: "inventory-items",
    title: "Inventários (itens conferidos)",
    description: "Itens conferidos nos inventários das suas unidades.",
    columns: [
      { key: "inventory_name", label: "Inventário" },
      { key: "patrimony_number", label: "Nº patrimonial" },
      { key: "result", label: "Resultado" },
      { key: "checked_at", label: "Conferido em (UTC)" },
      { key: "notes", label: "Observações", internal: true },
    ],
    filters: [
      { name: "inventory_id", type: "inventory" },
      { name: "unit_id", type: "unit" },
      { name: "inventory_status", type: "enum", options: ["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"] },
      { name: "result", type: "enum", options: ["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"] },
      { name: "checked_from", type: "date" },
      { name: "checked_to", type: "date" },
    ],
    sorts: ["checked_at", "-checked_at", "patrimony_number", "-patrimony_number", "result", "-result"],
    default_sort: "-checked_at",
  },
];

/** Contrato antigo: sala/responsável como UUID livre e vínculo como texto. */
function legacyFilters(filters: Def["filters"]): Def["filters"] {
  return filters.map((filter) => {
    if (filter.type === "room" || filter.type === "person") return { name: filter.name, type: "uuid" };
    if (filter.name === "bond_status") return { name: filter.name, type: "text", max_length: 64 };
    return filter;
  });
}

function withOptions(filters: Def["filters"], bondStatusOptions: string[] | null): Def["filters"] {
  if (!bondStatusOptions) return filters;
  return filters.map((f) => (f.name === "bond_status" ? { ...f, options: bondStatusOptions } : f));
}

export function reportsCatalog(role: "ADM" | "USER" | "RH", legacy = false, bondStatusOptions: string[] | null = null) {
  return {
    generated_at: "2026-10-21T12:00:00+00:00",
    max_rows: 10000,
    formats: ["csv", "xlsx"],
    reports: DEFS.map((def) => ({
      id: def.id,
      title: def.title,
      description: def.description,
      export_path: `/api/v1/reports/${def.id}/export`,
      formats: ["csv", "xlsx"],
      columns: def.columns.filter((c) => role !== "RH" || !c.internal).map(({ key, label }) => ({ key, label })),
      filters: legacy ? legacyFilters(def.filters) : withOptions(def.filters, bondStatusOptions),
      sorts: def.sorts,
      default_sort: def.default_sort,
      include_deleted_allowed: role === "ADM",
    })),
  };
}

const CSV_MIME = "text/csv; charset=utf-8";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function cors(headers: Record<string, string>, extra: Record<string, string> = {}) {
  return { ...headers, ...extra };
}

function err(route: Route, headers: Record<string, string>, status: number, code: string, extra: Record<string, string> = {}) {
  return route.fulfill({
    status,
    headers: cors(headers, { "content-type": "application/json", ...extra }),
    body: JSON.stringify({ error: { code, message: "detalhe interno sintético" } }),
  });
}

/** `true` = requisição tratada. */
export async function handleReports(args: {
  route: Route;
  state: ReportsHandlerState;
  method: string;
  path: string;
  url: URL;
  cors: Record<string, string>;
}): Promise<boolean> {
  const { route, state, method, path, url, cors: corsHeaders } = args;
  const catalog = path === "/v1/reports";
  const exportMatch = /^\/v1\/reports\/([^/]+)\/export$/.exec(path);
  if (!(catalog || exportMatch) || method !== "GET") return false;

  if (state.role === "ADM" && state.aal !== "aal2") return err(route, corsHeaders, 403, "AAL2_REQUIRED").then(() => true);

  if (catalog) {
    if (state.reports.catalogStatus) {
      await err(route, corsHeaders, state.reports.catalogStatus, "ERRO");
      return true;
    }
    if ([...url.searchParams.keys()].length > 0) {
      await err(route, corsHeaders, 400, "validation_error");
      return true;
    }
    await route.fulfill({
      status: 200,
      headers: cors(corsHeaders, { "content-type": "application/json", "cache-control": "no-store" }),
      body: JSON.stringify(
        reportsCatalog(state.role, state.reports.legacyFilterTypes, state.reports.bondStatusOptions),
      ),
    });
    return true;
  }

  const kind = exportMatch![1]!;
  const def = DEFS.find((d) => d.id === kind);
  if (state.reports.exportDelayMs > 0) await new Promise((r) => setTimeout(r, state.reports.exportDelayMs));
  if (state.reports.exportStatus) {
    const extra: Record<string, string> = state.reports.exportStatus === 429 ? { "retry-after": String(state.reports.retryAfter), "access-control-expose-headers": "Retry-After" } : {};
    await err(route, corsHeaders, state.reports.exportStatus, state.reports.exportStatus === 429 ? "RATE_LIMITED" : "ERRO", extra);
    return true;
  }
  if (!def) {
    await err(route, corsHeaders, 404, "not_found");
    return true;
  }
  const allowed = new Set(["format", "sort", "include_deleted", "columns", ...def.filters.map((f) => f.name)]);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      await err(route, corsHeaders, 400, "validation_error");
      return true;
    }
    seen.add(key);
  }
  const format = url.searchParams.get("format") ?? "csv";
  const sort = url.searchParams.get("sort") ?? def.default_sort;
  if (!["csv", "xlsx"].includes(format) || !def.sorts.includes(sort)) {
    await err(route, corsHeaders, 400, "validation_error");
    return true;
  }
  for (const filter of def.filters) {
    const value = url.searchParams.get(filter.name);
    if (value === null) continue;
    const options = filter.name === "bond_status" && state.reports.bondStatusOptions
      ? state.reports.bondStatusOptions
      : (filter.options ?? []);
    if (filter.type === "enum" && !options.includes(value)) {
      await err(route, corsHeaders, 400, "validation_error");
      return true;
    }
    if (filter.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      await err(route, corsHeaders, 400, "validation_error");
      return true;
    }
    if (filter.type === "unit" && !Object.values(state.unitDetails).some((u) => u.id === value)) {
      await err(route, corsHeaders, 404, "not_found");
      return true;
    }
    if (filter.type === "inventory" && !state.inventories.some((i) => i.id === value)) {
      await err(route, corsHeaders, 404, "not_found");
      return true;
    }
    // Sala/responsável inexistente, malformado ou de unidade alheia: o MESMO 404.
    if (filter.type === "room" && !state.rooms.some((r) => r.id === value)) {
      await err(route, corsHeaders, 404, "not_found");
      return true;
    }
    if (filter.type === "person" && !state.people.some((p) => p.id === value)) {
      await err(route, corsHeaders, 404, "not_found");
      return true;
    }
  }
  if (url.searchParams.get("include_deleted") === "true" && state.role !== "ADM") {
    await err(route, corsHeaders, 403, "forbidden");
    return true;
  }
  const q = url.searchParams.get("q");
  if (q === "limite") {
    await err(route, corsHeaders, 413, "row_limit_exceeded");
    return true;
  }
  const rows = q === "vazio" ? 0 : state.reports.rows;
  const visible = def.columns.filter((c) => state.role !== "RH" || !c.internal);
  // `columns` = chaves separadas por vírgula; ausente = todas; desconhecida/repetida => 400.
  const rawColumns = url.searchParams.get("columns");
  let columns = visible;
  if (rawColumns !== null) {
    const keys = rawColumns.split(",");
    const known = new Set(visible.map((c) => c.key));
    if (keys.some((k) => !known.has(k)) || new Set(keys).size !== keys.length) {
      await err(route, corsHeaders, 400, "invalid_columns");
      return true;
    }
    columns = visible.filter((c) => keys.includes(c.key));
  }
  const stamp = "20261021T120000Z";
  if (format === "xlsx") {
    await route.fulfill({
      status: 200,
      headers: cors(corsHeaders, {
        "content-type": XLSX_MIME,
        "content-disposition": `attachment; filename="sispat-${kind}-${stamp}.xlsx"`,
        "cache-control": "no-store",
      }),
      body: Buffer.from("PK\u0003\u0004sintetico"),
    });
    return true;
  }
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [columns.map((c) => quote(c.label)).join(";")];
  for (let i = 0; i < rows; i += 1) {
    lines.push(columns.map((c) => quote(c.key === "description" ? `Bem "${i}"\nlinha 2` : `${c.key}-${i}`)).join(";"));
  }
  await route.fulfill({
    status: 200,
    headers: cors(corsHeaders, {
      "content-type": CSV_MIME,
      "content-disposition": `attachment; filename="sispat-${kind}-${stamp}.csv"`,
      "cache-control": "no-store",
      "x-report-rows": String(rows),
    }),
    body: `﻿${lines.join("\r\n")}\r\n`,
  });
  return true;
}
