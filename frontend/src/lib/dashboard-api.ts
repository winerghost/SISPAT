// =============================================================================
// SISPAT-AGU — dashboard-api.ts
// =============================================================================
// Contrato dos indicadores do painel patrimonial (`/api/v1/dashboard/*`).
// Só transporte + validação por allowlist: resposta fora do formato é
// REJEITADA (a tela mostra erro; nada é renderizado sem ser reconhecido).
// Os números são exatamente os do backend — o frontend não calcula, estima nem
// completa nada. Escopo por perfil/unidade é decisão do backend.
//
//   GET /v1/dashboard/resumo
//   GET /v1/dashboard/por-unidade
//   GET /v1/dashboard/por-situacao
//   GET /v1/dashboard/aquisicoes-mensais?meses=6
//   GET /v1/dashboard/localizacao-por-unidade
//   GET /v1/dashboard/por-vinculo
//   GET /v1/dashboard/pendencias-cadastro
//   GET /v1/dashboard/por-sala
//   GET /v1/dashboard/inventario
//   GET /v1/dashboard/tipos
//   GET /v1/dashboard/tecnologia/{resumo,por-categoria,por-unidade,por-status,
//                                 sem-responsavel,tempo-registro}
//   GET /v1/dashboard/tecnologia/export?format=csv|xlsx   (arquivo, auditado)
//
// Painéis de TECNOLOGIA: aceitam os filtros comuns + `categoria`, `tipo_ti` e
// `status` (classificação). Os endpoints ANTERIORES recusam (400) essas três
// chaves, então elas só saem nas consultas de Tecnologia e nunca entram nas
// queryKeys dos demais painéis (trocar a classificação não refaz as outras
// consultas).
//
// FILTROS (docs/architecture/dashboard-api.md): todos os endpoints aceitam o
// mesmo conjunto (`DashboardFilters`). Aqui eles só são SERIALIZADOS: chaves
// fora da allowlist nunca saem e valores obviamente inválidos são descartados
// para não gastar requisição — a validação real (400) e o escopo de unidade
// são do backend. Os filtros entram em TODAS as queryKeys.
//
// `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE `null` (o cadastro
// ainda não possui esses campos). Um valor numérico nesses campos é tratado
// como resposta inválida — a UI nunca exibe número que o contrato não prevê.
// `variacao.total_bens` é a variação percentual (%) informada pelo backend.
// =============================================================================

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Filtros (allowlist, ordem = ordem do schema do backend)
// ---------------------------------------------------------------------------

export const DASHBOARD_FILTER_KEYS = [
  "unit_id",
  "owner_unit_id",
  "room_id",
  "responsible_person_id",
  "has_room",
  "has_responsible",
  "located",
  "bond_status",
  "tipo",
  "registrado_desde",
  "registrado_ate",
  "inventario",
  "movimentacao_pendente",
  "categoria",
  "tipo_ti",
  "status",
] as const;

/** Chaves de classificação: valem SÓ para os painéis de Tecnologia. */
export const TECH_FILTER_KEYS = ["categoria", "tipo_ti", "status"] as const;
export type TechFilterKey = (typeof TECH_FILTER_KEYS)[number];
const isTechKey = (key: string): key is TechFilterKey => (TECH_FILTER_KEYS as readonly string[]).includes(key);

export type DashboardFilterKey = (typeof DASHBOARD_FILTER_KEYS)[number];

export type BoolText = "true" | "false";
export type LocatedFilterValue = "SIM" | "NAO" | "DESCONHECIDO";
export type InventoryFilterValue = "conferido" | "nao_conferido" | "encontrado" | "nao_encontrado";
export type CategoriaFilterValue =
  | "TECNOLOGIA"
  | "MOBILIARIO"
  | "VEICULO"
  | "EQUIPAMENTO"
  | "OUTROS"
  | "NAO_CLASSIFICADO";
export type TipoTiFilterValue = "COMPUTADOR" | "NOTEBOOK" | "MONITOR" | "IMPRESSORA" | "OUTRO_TI" | "NAO_INFORMADO";
export type StatusFilterValue = "EM_USO" | "ESTOQUE" | "MANUTENCAO" | "BAIXADO" | "NAO_INFORMADO";

/** Todos opcionais; ausente = sem filtro. Valores sempre texto (como na URL). */
export interface DashboardFilters {
  unit_id?: string;
  owner_unit_id?: string;
  room_id?: string;
  responsible_person_id?: string;
  has_room?: BoolText;
  has_responsible?: BoolText;
  located?: LocatedFilterValue;
  bond_status?: string;
  tipo?: string;
  registrado_desde?: string;
  registrado_ate?: string;
  inventario?: InventoryFilterValue;
  movimentacao_pendente?: BoolText;
  /** Só painéis de Tecnologia. */
  categoria?: CategoriaFilterValue;
  tipo_ti?: TipoTiFilterValue;
  status?: StatusFilterValue;
}

export const NO_DASHBOARD_FILTERS: DashboardFilters = Object.freeze({});

/** Valor reservado: bens sem vínculo (`bond_status IS NULL`). */
export const BOND_NONE = "__none__";
export const TIPO_NAO_CLASSIFICADO = "NAO_CLASSIFICADO";
export const PERIOD_MAX_YEARS = 5;

export const LOCATED_VALUES: readonly LocatedFilterValue[] = ["SIM", "NAO", "DESCONHECIDO"];
export const INVENTORY_VALUES: readonly InventoryFilterValue[] = [
  "conferido",
  "nao_conferido",
  "encontrado",
  "nao_encontrado",
];

export const CATEGORIA_VALUES: readonly CategoriaFilterValue[] = [
  "TECNOLOGIA",
  "MOBILIARIO",
  "VEICULO",
  "EQUIPAMENTO",
  "OUTROS",
  "NAO_CLASSIFICADO",
];
export const TIPO_TI_VALUES: readonly TipoTiFilterValue[] = [
  "COMPUTADOR",
  "NOTEBOOK",
  "MONITOR",
  "IMPRESSORA",
  "OUTRO_TI",
  "NAO_INFORMADO",
];
export const STATUS_VALUES: readonly StatusFilterValue[] = [
  "EM_USO",
  "ESTOQUE",
  "MANUTENCAO",
  "BAIXADO",
  "NAO_INFORMADO",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPO_RE = /^(?:[A-Z0-9]{1,40}|NAO_CLASSIFICADO)$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Caracteres de controle (C0, DEL, C1): o backend recusa; não enviamos.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const BOND_MAX = 64;

const isBoolText = (v: string): v is BoolText => v === "true" || v === "false";

/** Data de calendário AAAA-MM-DD existente (ano ≥ 1900). */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `desde` + N anos (29/02 → 28/02), igual ao backend. */
function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split("-");
  const year = String(Number(y) + years).padStart(4, "0");
  const candidate = `${year}-${m}-${d}`;
  return isCalendarDate(candidate) ? candidate : `${year}-${m}-28`;
}

/** Período válido para o backend: `desde ≤ ate` e janela ≤ 5 anos. */
export function isValidPeriod(desde: string, ate: string): boolean {
  return desde <= ate && ate <= addYears(desde, PERIOD_MAX_YEARS);
}

/** Valida UM valor pela regra da chave; `null` = descartar. */
function cleanFilterValue(key: DashboardFilterKey, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  switch (key) {
    case "unit_id":
    case "owner_unit_id":
    case "room_id":
    case "responsible_person_id":
      return UUID_RE.test(raw) ? raw.toLowerCase() : null;
    case "has_room":
    case "has_responsible":
    case "movimentacao_pendente":
      return isBoolText(raw) ? raw : null;
    case "located":
      return (LOCATED_VALUES as readonly string[]).includes(raw) ? raw : null;
    case "inventario":
      return (INVENTORY_VALUES as readonly string[]).includes(raw) ? raw : null;
    case "bond_status": {
      if (CONTROL_RE.test(raw)) return null;
      const text = raw.trim().replace(/\s+/g, " ");
      return text.length > 0 && text.length <= BOND_MAX ? text : null;
    }
    case "tipo":
      return TIPO_RE.test(raw) && raw !== "OUTROS" ? raw : null;
    case "registrado_desde":
    case "registrado_ate":
      return isCalendarDate(raw) ? raw : null;
    case "categoria":
      return (CATEGORIA_VALUES as readonly string[]).includes(raw) ? raw : null;
    case "tipo_ti":
      return (TIPO_TI_VALUES as readonly string[]).includes(raw) ? raw : null;
    case "status":
      return (STATUS_VALUES as readonly string[]).includes(raw) ? raw : null;
  }
}

/**
 * Filtros limpos: só chaves da allowlist, valores válidos, na ordem fixa.
 * Período inválido (invertido ou > 5 anos) descarta `registrado_ate`.
 */
export function sanitizeDashboardFilters(input: Partial<Record<string, unknown>>): DashboardFilters {
  const out: Record<string, string> = {};
  for (const key of DASHBOARD_FILTER_KEYS) {
    const value = cleanFilterValue(key, input[key]);
    if (value !== null) out[key] = value;
  }
  if (out.registrado_desde && out.registrado_ate && !isValidPeriod(out.registrado_desde, out.registrado_ate)) {
    delete out.registrado_ate;
  }
  return out as DashboardFilters;
}

/**
 * Lê os filtros de uma query string (URL do navegador). Chave desconhecida é
 * ignorada; chave repetida ou valor inválido é descartado (nunca quebra a tela).
 */
export function parseDashboardFilters(params: { getAll(name: string): string[] }): DashboardFilters {
  const raw: Record<string, string> = {};
  for (const key of DASHBOARD_FILTER_KEYS) {
    const values = params.getAll(key);
    if (values.length === 1) raw[key] = values[0]!;
  }
  return sanitizeDashboardFilters(raw);
}

/** Quais chaves entram: `all` (URL e Tecnologia) ou `base` (painéis gerais, sem classificação). */
export type FilterScope = "all" | "base";

/** Pares chave/valor na ordem fixa (para a API e para a URL). */
export function dashboardFilterEntries(
  filters: DashboardFilters,
  scope: FilterScope = "all",
): [DashboardFilterKey, string][] {
  const clean = sanitizeDashboardFilters(filters as Record<string, unknown>);
  return DASHBOARD_FILTER_KEYS.flatMap((key) => {
    const value = clean[key];
    if (value === undefined || (scope === "base" && isTechKey(key))) return [];
    return [[key, value] as [DashboardFilterKey, string]];
  });
}

/** Query string estável (`a=1&b=2`, sem "?"); vazia sem filtros. */
export function dashboardFiltersQueryString(filters: DashboardFilters, scope: FilterScope = "all"): string {
  return new URLSearchParams(dashboardFilterEntries(filters, scope)).toString();
}

export function countDashboardFilters(filters: DashboardFilters): number {
  return dashboardFilterEntries(filters).length;
}

/** Remove uma chave (ex.: `/tipos` não precisa do próprio `tipo`). */
export function withoutFilter(filters: DashboardFilters, key: DashboardFilterKey): DashboardFilters {
  const rest: DashboardFilters = { ...filters };
  delete rest[key];
  return rest;
}

// ---------------------------------------------------------------------------
// Tipos das respostas
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  total_bens: number;
  localizados: number;
  nao_localizados: number;
  desconhecidos: number;
  movimentacoes_pendentes: number;
  inventarios_abertos: number;
  novos_30d: number;
  valor_total: null;
  em_manutencao: null;
  baixas_ano: null;
  variacao: {
    total_bens: number | null;
    valor_total: null;
    em_manutencao: null;
    baixas_ano: null;
  };
  /** NOMES dos filtros que o backend aplicou (nunca valores). */
  filtros_aplicados: DashboardFilterKey[];
}

export interface UnitBreakdownRow {
  unidade: string;
  /** Opcional (backend futuro): UUID da unidade, usado no clique → filtro. */
  unit_id?: string;
  total: number;
  tipos: Record<string, number>;
}

export interface SituationSlice {
  id: string;
  value: number;
}

export interface MonthlyPoint {
  /** Mês no formato "YYYY-MM". */
  x: string;
  y: number;
}

export interface MonthlySeries {
  id: string;
  data: MonthlyPoint[];
}

export interface UnitLocationRow {
  unidade: string;
  /** Opcional (backend futuro): UUID da unidade, usado no clique → filtro. */
  unit_id?: string;
  sim: number;
  nao: number;
  desconhecido: number;
  total: number;
}

/** Item rotulado (vínculo/sala): `id` técnico + `label` vindo da planilha (texto). */
export interface LabeledCount {
  id: string;
  label: string;
  value: number;
}

export interface RegistrationPending {
  sem_responsavel: number;
  sem_sala: number;
  ociosos: number;
  nao_localizados: number;
}

export interface InventoryStatus {
  conferidos: number;
  nao_conferidos: number;
  encontrados: number;
  nao_encontrados: number;
}

export interface TypeOption {
  value: string;
  count: number;
}

// --- Tecnologia ---------------------------------------------------------------

export interface TechSummary {
  total_bens: number;
  tecnologia: number;
  nao_classificados: number;
  tecnologia_sem_responsavel: number;
  tecnologia_sem_tipo: number;
  tecnologia_sem_status: number;
  /** NOMES dos filtros aplicados pelo backend (nunca valores). */
  filtros_aplicados: DashboardFilterKey[];
}

/** `id` do vocabulário fechado + `label` pt-BR do backend + contagem (> 0). */
export interface TechCount {
  id: string;
  label: string;
  value: number;
}

export interface TechCategories {
  categorias: TechCount[];
  tipos_ti: TechCount[];
}

export interface TechUnitRow {
  unidade: string;
  total: number;
  tipos: Record<string, number>;
}

export interface TechWithoutOwner {
  tecnologia: number;
  sem_responsavel: number;
  /** Percentual (%) calculado pelo backend; `null` sem bens de TI. */
  percentual: number | null;
  por_unidade: { unidade: string; value: number }[];
}

// ---------------------------------------------------------------------------
// Limites (defesa em profundidade contra respostas anômalas)
// ---------------------------------------------------------------------------

const MAX_ROWS = 500;
const MAX_TYPES = 100;
const MAX_SERIES = 12;
const MAX_POINTS = 36;
const MAX_TEXT = 200;
const MAX_LABEL = 300;
/** top 15 + "Outras"/"Sem sala" (e folga). */
const MAX_LABELED_ROWS = 20;
const MAX_TYPE_OPTIONS = 50;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const MONTHS_DEFAULT = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_LABEL;
}

/** `unit_id` é opcional; se vier, precisa ser UUID. */
function optionalUnitId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && UUID_RE.test(value));
}

function hasCounts(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => isCount(value[field]));
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const SUMMARY_COUNTS = [
  "total_bens",
  "localizados",
  "nao_localizados",
  "desconhecidos",
  "movimentacoes_pendentes",
  "inventarios_abertos",
  "novos_30d",
] as const;

function isAppliedFilters(value: unknown): value is DashboardFilterKey[] {
  return (
    Array.isArray(value) &&
    value.length <= DASHBOARD_FILTER_KEYS.length &&
    value.every((name) => (DASHBOARD_FILTER_KEYS as readonly unknown[]).includes(name) && !isTechKey(String(name)))
  );
}

export function isDashboardSummary(value: unknown): value is DashboardSummary {
  if (!isRecord(value)) return false;
  if (!hasCounts(value, SUMMARY_COUNTS)) return false;
  if (value.valor_total !== null || value.em_manutencao !== null || value.baixas_ano !== null) return false;
  // Ausente = backend sem filtros (lista vazia); presente = só nomes da allowlist.
  if (value.filtros_aplicados !== undefined && !isAppliedFilters(value.filtros_aplicados)) return false;
  const variacao = value.variacao;
  if (!isRecord(variacao)) return false;
  const delta = variacao.total_bens;
  const deltaOk = delta === null || (typeof delta === "number" && Number.isFinite(delta));
  return (
    deltaOk &&
    variacao.valor_total === null &&
    variacao.em_manutencao === null &&
    variacao.baixas_ano === null
  );
}

export function isUnitBreakdownRow(value: unknown): value is UnitBreakdownRow {
  if (!isRecord(value)) return false;
  if (!isKey(value.unidade) || !isCount(value.total) || !isRecord(value.tipos)) return false;
  if (!optionalUnitId(value.unit_id)) return false;
  const entries = Object.entries(value.tipos);
  return entries.length <= MAX_TYPES && entries.every(([tipo, count]) => isKey(tipo) && isCount(count));
}

export function isUnitBreakdown(value: unknown): value is UnitBreakdownRow[] {
  return Array.isArray(value) && value.length <= MAX_ROWS && value.every(isUnitBreakdownRow);
}

export function isSituationSlice(value: unknown): value is SituationSlice {
  return isRecord(value) && isKey(value.id) && isCount(value.value);
}

export function isSituationBreakdown(value: unknown): value is SituationSlice[] {
  return Array.isArray(value) && value.length <= MAX_ROWS && value.every(isSituationSlice);
}

export function isMonthlySeries(value: unknown): value is MonthlySeries {
  if (!isRecord(value) || !isKey(value.id) || !Array.isArray(value.data)) return false;
  return (
    value.data.length <= MAX_POINTS &&
    value.data.every(
      (point) =>
        isRecord(point) && typeof point.x === "string" && MONTH_PATTERN.test(point.x) && isCount(point.y),
    )
  );
}

export function isMonthlyAcquisitions(value: unknown): value is MonthlySeries[] {
  return Array.isArray(value) && value.length <= MAX_SERIES && value.every(isMonthlySeries);
}

export function isUnitLocationRow(value: unknown): value is UnitLocationRow {
  return (
    isRecord(value) &&
    isKey(value.unidade) &&
    optionalUnitId(value.unit_id) &&
    hasCounts(value, ["sim", "nao", "desconhecido", "total"])
  );
}

export function isUnitLocation(value: unknown): value is UnitLocationRow[] {
  return Array.isArray(value) && value.length <= MAX_LABELED_ROWS && value.every(isUnitLocationRow);
}

export function isLabeledCount(value: unknown): value is LabeledCount {
  return isRecord(value) && isKey(value.id) && isLabel(value.label) && isCount(value.value);
}

export function isLabeledCounts(value: unknown): value is LabeledCount[] {
  return Array.isArray(value) && value.length <= MAX_LABELED_ROWS && value.every(isLabeledCount);
}

export function isRegistrationPending(value: unknown): value is RegistrationPending {
  return isRecord(value) && hasCounts(value, ["sem_responsavel", "sem_sala", "ociosos", "nao_localizados"]);
}

export function isInventoryStatus(value: unknown): value is InventoryStatus {
  return isRecord(value) && hasCounts(value, ["conferidos", "nao_conferidos", "encontrados", "nao_encontrados"]);
}

export function isTypeOptions(value: unknown): value is TypeOption[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TYPE_OPTIONS &&
    value.every(
      (item) => isRecord(item) && typeof item.value === "string" && TIPO_RE.test(item.value) && isCount(item.count),
    )
  );
}

const TECH_ID_RE = /^[A-Z_]{1,32}$/;
const TECH_AGE_ID_RE = /^[a-z0-9_]{1,24}$/;
const MAX_TECH_ITEMS = 8;

export function isTechSummary(value: unknown): value is TechSummary {
  if (!isRecord(value)) return false;
  if (
    !hasCounts(value, [
      "total_bens",
      "tecnologia",
      "nao_classificados",
      "tecnologia_sem_responsavel",
      "tecnologia_sem_tipo",
      "tecnologia_sem_status",
    ])
  ) {
    return false;
  }
  const applied = value.filtros_aplicados;
  return (
    Array.isArray(applied) &&
    applied.length <= DASHBOARD_FILTER_KEYS.length &&
    applied.every((name) => (DASHBOARD_FILTER_KEYS as readonly unknown[]).includes(name))
  );
}

function techCountGuard(pattern: RegExp) {
  const isItem = (value: unknown): value is TechCount =>
    isRecord(value) &&
    typeof value.id === "string" &&
    pattern.test(value.id) &&
    isLabel(value.label) &&
    isCount(value.value) &&
    value.value > 0;
  return (value: unknown): value is TechCount[] =>
    Array.isArray(value) && value.length <= MAX_TECH_ITEMS && value.every(isItem);
}

export const isTechCounts = techCountGuard(TECH_ID_RE);
export const isTechAge = techCountGuard(TECH_AGE_ID_RE);

export function isTechCategories(value: unknown): value is TechCategories {
  return isRecord(value) && isTechCounts(value.categorias) && isTechCounts(value.tipos_ti);
}

export function isTechUnits(value: unknown): value is TechUnitRow[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LABELED_ROWS &&
    value.every(
      (row) =>
        isRecord(row) &&
        isKey(row.unidade) &&
        isCount(row.total) &&
        isRecord(row.tipos) &&
        Object.entries(row.tipos).length <= MAX_TECH_ITEMS &&
        Object.entries(row.tipos).every(([name, n]) => isKey(name) && isCount(n)),
    )
  );
}

export function isTechWithoutOwner(value: unknown): value is TechWithoutOwner {
  if (!isRecord(value) || !hasCounts(value, ["tecnologia", "sem_responsavel"])) return false;
  const pct = value.percentual;
  if (pct !== null && !(typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100)) return false;
  return (
    Array.isArray(value.por_unidade) &&
    value.por_unidade.length <= MAX_LABELED_ROWS &&
    value.por_unidade.every((row) => isRecord(row) && isKey(row.unidade) && isCount(row.value) && row.value > 0)
  );
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

type SearchParams = Record<string, string | number>;

/** `scope="base"` (padrão): os endpoints gerais recusam as chaves de classificação. */
export function filterParams(
  filters: DashboardFilters,
  extra?: SearchParams,
  scope: FilterScope = "base",
): SearchParams | undefined {
  const params: SearchParams = Object.fromEntries(dashboardFilterEntries(filters, scope));
  if (extra) Object.assign(params, extra);
  return Object.keys(params).length > 0 ? params : undefined;
}

async function fetchValidated<T>(
  path: string,
  guard: (value: unknown) => value is T,
  label: string,
  searchParams?: SearchParams,
): Promise<T> {
  const data = await apiClient.get<unknown>(path, searchParams ? { searchParams } : undefined);
  if (!guard(data)) throw new Error(`Resposta de ${label} inválida.`);
  return data;
}

/** `GET /api/v1/dashboard/resumo` — qualquer perfil autenticado, escopo no backend. */
export const getDashboardSummary = async (filters: DashboardFilters = NO_DASHBOARD_FILTERS) => {
  const data = await fetchValidated("/v1/dashboard/resumo", isDashboardSummary, "indicadores", filterParams(filters));
  return { ...data, filtros_aplicados: data.filtros_aplicados ?? [] };
};

/** `GET /api/v1/dashboard/por-unidade`. */
export const getDashboardByUnit = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/por-unidade", isUnitBreakdown, "bens por unidade", filterParams(filters));

/** `GET /api/v1/dashboard/por-situacao`. */
export const getDashboardBySituation = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/por-situacao", isSituationBreakdown, "bens por situação", filterParams(filters));

/** `GET /api/v1/dashboard/aquisicoes-mensais?meses=N`. */
export const getDashboardMonthlyAcquisitions = (
  months: number = MONTHS_DEFAULT,
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
) =>
  fetchValidated(
    "/v1/dashboard/aquisicoes-mensais",
    isMonthlyAcquisitions,
    "aquisições mensais",
    filterParams(filters, { meses: months }),
  );

/** `GET /api/v1/dashboard/localizacao-por-unidade` (top 15 + "Outras"). */
export const getDashboardUnitLocation = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated(
    "/v1/dashboard/localizacao-por-unidade",
    isUnitLocation,
    "localização por unidade",
    filterParams(filters),
  );

/** `GET /api/v1/dashboard/por-vinculo` (top 8 + "Outros" + "Sem vínculo"). */
export const getDashboardByBond = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/por-vinculo", isLabeledCounts, "bens por vínculo", filterParams(filters));

/** `GET /api/v1/dashboard/pendencias-cadastro`. */
export const getDashboardPending = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated(
    "/v1/dashboard/pendencias-cadastro",
    isRegistrationPending,
    "pendências de cadastro",
    filterParams(filters),
  );

/** `GET /api/v1/dashboard/por-sala` (top 15 + "Outras" + "Sem sala"). */
export const getDashboardByRoom = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/por-sala", isLabeledCounts, "bens por sala", filterParams(filters));

/** `GET /api/v1/dashboard/inventario`. */
export const getDashboardInventory = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/inventario", isInventoryStatus, "inventário", filterParams(filters));

/** `GET /api/v1/dashboard/tipos` — opções do filtro "Tipo" (o próprio `tipo` não é enviado). */
export const getDashboardTypes = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  fetchValidated("/v1/dashboard/tipos", isTypeOptions, "tipos de bem", filterParams(withoutFilter(filters, "tipo")));

// --- Tecnologia: sempre com TODAS as chaves (comuns + classificação) -------------

const techGet = <T,>(path: string, guard: (value: unknown) => value is T, label: string, filters: DashboardFilters) =>
  fetchValidated(`/v1/dashboard/tecnologia/${path}`, guard, label, filterParams(filters, undefined, "all"));

export const getTechSummary = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("resumo", isTechSummary, "indicadores de tecnologia", filters);
export const getTechCategories = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("por-categoria", isTechCategories, "tecnologia por categoria", filters);
export const getTechByUnit = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("por-unidade", isTechUnits, "tecnologia por unidade", filters);
export const getTechByStatus = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("por-status", isTechCounts, "tecnologia por situação operacional", filters);
export const getTechWithoutOwner = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("sem-responsavel", isTechWithoutOwner, "tecnologia sem responsável", filters);
export const getTechRegistrationAge = (filters: DashboardFilters = NO_DASHBOARD_FILTERS) =>
  techGet("tempo-registro", isTechAge, "tempo desde o registro", filters);

// ---------------------------------------------------------------------------
// Hooks (react-query) — filtros em TODAS as queryKeys
// ---------------------------------------------------------------------------

/**
 * Parte da queryKey que identifica os filtros (string estável, ordem fixa).
 * Painéis gerais ignoram a classificação; os de Tecnologia usam todas as chaves.
 */
const filterKey = (filters: DashboardFilters) => dashboardFiltersQueryString(filters, "base");
const techFilterKey = (filters: DashboardFilters) => dashboardFiltersQueryString(filters, "all");

export const DASHBOARD_QUERY_KEYS = {
  summary: (filters: DashboardFilters) => ["dashboard", "resumo", filterKey(filters)],
  byUnit: (filters: DashboardFilters) => ["dashboard", "por-unidade", filterKey(filters)],
  bySituation: (filters: DashboardFilters) => ["dashboard", "por-situacao", filterKey(filters)],
  monthly: (months: number, filters: DashboardFilters) => ["dashboard", "aquisicoes-mensais", months, filterKey(filters)],
  unitLocation: (filters: DashboardFilters) => ["dashboard", "localizacao-por-unidade", filterKey(filters)],
  byBond: (filters: DashboardFilters) => ["dashboard", "por-vinculo", filterKey(filters)],
  pending: (filters: DashboardFilters) => ["dashboard", "pendencias-cadastro", filterKey(filters)],
  byRoom: (filters: DashboardFilters) => ["dashboard", "por-sala", filterKey(filters)],
  inventory: (filters: DashboardFilters) => ["dashboard", "inventario", filterKey(filters)],
  types: (filters: DashboardFilters) => ["dashboard", "tipos", filterKey(withoutFilter(filters, "tipo"))],
  tech: (name: string, filters: DashboardFilters) => ["dashboard", "tecnologia", name, techFilterKey(filters)],
} as const;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

const COMMON = { retry: shouldRetry, staleTime: 60_000 } as const;

export function useDashboardSummary(
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
): UseQueryResult<DashboardSummary, unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.summary(filters),
    queryFn: () => getDashboardSummary(filters),
    ...COMMON,
  });
}

export function useDashboardByUnit(
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
): UseQueryResult<UnitBreakdownRow[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.byUnit(filters),
    queryFn: () => getDashboardByUnit(filters),
    ...COMMON,
  });
}

export function useDashboardBySituation(
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
): UseQueryResult<SituationSlice[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.bySituation(filters),
    queryFn: () => getDashboardBySituation(filters),
    ...COMMON,
  });
}

export function useDashboardMonthlyAcquisitions(
  months: number = MONTHS_DEFAULT,
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
): UseQueryResult<MonthlySeries[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.monthly(months, filters),
    queryFn: () => getDashboardMonthlyAcquisitions(months, filters),
    ...COMMON,
  });
}

export function useDashboardUnitLocation(filters: DashboardFilters): UseQueryResult<UnitLocationRow[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.unitLocation(filters),
    queryFn: () => getDashboardUnitLocation(filters),
    ...COMMON,
  });
}

export function useDashboardByBond(filters: DashboardFilters): UseQueryResult<LabeledCount[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.byBond(filters),
    queryFn: () => getDashboardByBond(filters),
    ...COMMON,
  });
}

export function useDashboardPending(filters: DashboardFilters): UseQueryResult<RegistrationPending, unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.pending(filters),
    queryFn: () => getDashboardPending(filters),
    ...COMMON,
  });
}

export function useDashboardByRoom(filters: DashboardFilters): UseQueryResult<LabeledCount[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.byRoom(filters),
    queryFn: () => getDashboardByRoom(filters),
    ...COMMON,
  });
}

export function useDashboardInventory(filters: DashboardFilters): UseQueryResult<InventoryStatus, unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.inventory(filters),
    queryFn: () => getDashboardInventory(filters),
    ...COMMON,
  });
}

/** Opções do filtro "Tipo" (`enabled=false` no relatório, que não mostra o seletor). */
export function useDashboardTypes(
  filters: DashboardFilters,
  enabled = true,
): UseQueryResult<TypeOption[], unknown> {
  const base = withoutFilter(filters, "tipo");
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.types(base),
    queryFn: () => getDashboardTypes(base),
    enabled,
    ...COMMON,
  });
}

function useTechQuery<T>(
  name: string,
  fetcher: (filters: DashboardFilters) => Promise<T>,
  filters: DashboardFilters,
): UseQueryResult<T, unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.tech(name, filters),
    queryFn: () => fetcher(filters),
    ...COMMON,
  });
}

export const useTechSummary = (filters: DashboardFilters) => useTechQuery("resumo", getTechSummary, filters);
export const useTechCategories = (filters: DashboardFilters) =>
  useTechQuery("por-categoria", getTechCategories, filters);
export const useTechByUnit = (filters: DashboardFilters) => useTechQuery("por-unidade", getTechByUnit, filters);
export const useTechByStatus = (filters: DashboardFilters) => useTechQuery("por-status", getTechByStatus, filters);
export const useTechWithoutOwner = (filters: DashboardFilters) =>
  useTechQuery("sem-responsavel", getTechWithoutOwner, filters);
export const useTechRegistrationAge = (filters: DashboardFilters) =>
  useTechQuery("tempo-registro", getTechRegistrationAge, filters);
