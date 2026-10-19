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
//
// `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE `null` (o cadastro
// ainda não possui esses campos). Um valor numérico nesses campos é tratado
// como resposta inválida — a UI nunca exibe número que o contrato não prevê.
// `variacao.total_bens` é a variação percentual (%) informada pelo backend.
// =============================================================================

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Tipos
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
}

export interface UnitBreakdownRow {
  unidade: string;
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

// ---------------------------------------------------------------------------
// Limites (defesa em profundidade contra respostas anômalas)
// ---------------------------------------------------------------------------

const MAX_ROWS = 500;
const MAX_TYPES = 100;
const MAX_SERIES = 12;
const MAX_POINTS = 36;
const MAX_TEXT = 200;
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

export function isDashboardSummary(value: unknown): value is DashboardSummary {
  if (!isRecord(value)) return false;
  if (!SUMMARY_COUNTS.every((field) => isCount(value[field]))) return false;
  if (value.valor_total !== null || value.em_manutencao !== null || value.baixas_ano !== null) return false;
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

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

async function fetchValidated<T>(
  path: string,
  guard: (value: unknown) => value is T,
  label: string,
  searchParams?: Record<string, string | number>,
): Promise<T> {
  const data = await apiClient.get<unknown>(path, searchParams ? { searchParams } : undefined);
  if (!guard(data)) throw new Error(`Resposta de ${label} inválida.`);
  return data;
}

/** `GET /api/v1/dashboard/resumo` — qualquer perfil autenticado, escopo no backend. */
export const getDashboardSummary = () =>
  fetchValidated("/v1/dashboard/resumo", isDashboardSummary, "indicadores");

/** `GET /api/v1/dashboard/por-unidade`. */
export const getDashboardByUnit = () =>
  fetchValidated("/v1/dashboard/por-unidade", isUnitBreakdown, "bens por unidade");

/** `GET /api/v1/dashboard/por-situacao`. */
export const getDashboardBySituation = () =>
  fetchValidated("/v1/dashboard/por-situacao", isSituationBreakdown, "bens por situação");

/** `GET /api/v1/dashboard/aquisicoes-mensais?meses=N`. */
export const getDashboardMonthlyAcquisitions = (months: number = MONTHS_DEFAULT) =>
  fetchValidated("/v1/dashboard/aquisicoes-mensais", isMonthlyAcquisitions, "aquisições mensais", {
    meses: months,
  });

// ---------------------------------------------------------------------------
// Hooks (react-query)
// ---------------------------------------------------------------------------

export const DASHBOARD_QUERY_KEYS = {
  summary: ["dashboard", "resumo"],
  byUnit: ["dashboard", "por-unidade"],
  bySituation: ["dashboard", "por-situacao"],
  monthly: (months: number) => ["dashboard", "aquisicoes-mensais", months],
} as const;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

const COMMON = { retry: shouldRetry, staleTime: 60_000 } as const;

export function useDashboardSummary(): UseQueryResult<DashboardSummary, unknown> {
  return useQuery({ queryKey: DASHBOARD_QUERY_KEYS.summary, queryFn: getDashboardSummary, ...COMMON });
}

export function useDashboardByUnit(): UseQueryResult<UnitBreakdownRow[], unknown> {
  return useQuery({ queryKey: DASHBOARD_QUERY_KEYS.byUnit, queryFn: getDashboardByUnit, ...COMMON });
}

export function useDashboardBySituation(): UseQueryResult<SituationSlice[], unknown> {
  return useQuery({ queryKey: DASHBOARD_QUERY_KEYS.bySituation, queryFn: getDashboardBySituation, ...COMMON });
}

export function useDashboardMonthlyAcquisitions(
  months: number = MONTHS_DEFAULT,
): UseQueryResult<MonthlySeries[], unknown> {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEYS.monthly(months),
    queryFn: () => getDashboardMonthlyAcquisitions(months),
    ...COMMON,
  });
}
