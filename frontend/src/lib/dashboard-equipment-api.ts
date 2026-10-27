// =============================================================================
// SISPAT-AGU — dashboard-equipment-api.ts
// =============================================================================
// Contrato dos painéis do catálogo do dashboard (ONDA 2/3) e da fila de revisão
// de classificação. Só transporte + validação por allowlist: uma resposta fora
// do formato é REJEITADA (a tela mostra erro; nada é renderizado sem ser
// reconhecido). Os números são EXATAMENTE os do backend: o frontend não soma,
// não calcula percentuais e não estima nada. Quem pode ver o quê (perfil,
// unidade) é decisão do backend: o cliente só desenha o que vier.
//
//   GET  /v1/dashboard/panels/<id>/data?unit_id&familia&categoria
//   GET  /v1/dashboard/panels/<id>/export?format=csv|xlsx&...   (arquivo)
//   GET  /v1/dashboard/classificacao/revisao?page&page_size&unit_id&sort  (ADM)
//   GET  /v1/dashboard/classificacao/revisao/export?format&unit_id&sort   (ADM)
//   POST /v1/assets/<id>/category-override {category, version}            (ADM)
//
// 404 em um painel = inexistente OU proibido (indistinguível): a tela apenas o
// oculta, sem tratá-lo como falha de segurança.
// =============================================================================

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient, requestFile } from "@/lib/api-client";
import { saveBlob } from "@/lib/dashboard-export";

// ---------------------------------------------------------------------------
// Utilitários de validação (sem `any`)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullable = <T>(v: unknown, guard: (x: unknown) => x is T): v is T | null => v === null || guard(v);
const isArr = <T>(v: unknown, guard: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(guard);

/** Erro de contrato: a resposta não tem o formato esperado. */
export class ContractError extends Error {
  constructor(what: string) {
    super(`Resposta de ${what} inválida.`);
    this.name = "ContractError";
  }
}

// O catálogo (GET /dashboard/panels) e as preferências são lidos por
// `useDashboardPanelPrefs` (use-dashboard-panel-prefs.ts), que compartilha o
// cache com a tela "Personalizar painéis": salvar lá atualiza esta grade.

export const noRetryOn4xx = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

// ---------------------------------------------------------------------------
// Dados dos painéis (GET /dashboard/panels/<id>/data)
// ---------------------------------------------------------------------------

export const FAMILIA_VALUES = ["TI", "MOBILIARIO", "OUTROS", "NAO_CLASSIFICADO"] as const;
export type FamiliaValue = (typeof FAMILIA_VALUES)[number];

/** Filtros dos painéis. Valores vazios não saem na consulta. */
export interface PanelFilters {
  unit_id?: string;
  familia?: FamiliaValue;
  categoria?: string;
}

export const NO_PANEL_FILTERS: PanelFilters = {};

export function panelFilterParams(filters: PanelFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.unit_id) params.unit_id = filters.unit_id;
  if (filters.familia) params.familia = filters.familia;
  if (filters.categoria) params.categoria = filters.categoria;
  return params;
}

export interface LabeledValue {
  id: string;
  label: string;
}
export interface CardItem extends LabeledValue {
  value: number;
}
export interface CardsData {
  itens: CardItem[];
  total: number;
}
export interface UnitRow {
  unidade: string;
  total: number;
  valores: Record<string, number>;
}
export interface TableData {
  colunas: LabeledValue[];
  linhas: UnitRow[];
  total: number;
}
export interface ChartData {
  familia: string;
  familia_label: string;
  series: LabeledValue[];
  unidades: UnitRow[];
  total: number;
}
export interface Share extends CardItem {
  percentual: number | null;
}
export interface CategoryShare extends Share {
  familia: string;
}
export interface DistributionData {
  total: number;
  familias: Share[];
  categorias: CategoryShare[];
}
export interface RankingRow {
  unidade: string;
  notebooks: number;
  docking: number;
  sem_docking: number;
}
export interface RankingData {
  metodo: string;
  notebooks: number;
  docking: number;
  sem_docking: number;
  por_unidade: RankingRow[];
}
export interface RatioData {
  computadores: number;
  notebooks: number;
  monitores: number;
  monitores_por_computador: number | null;
  monitores_por_notebook: number | null;
}
export interface QueueSummaryData {
  total_pendentes: number;
  por_unidade: { unidade: string; value: number }[];
}
export interface OverrideRecent {
  asset_id: string;
  patrimony_number: string;
  description: string | null;
  categoria_anterior: string | null;
  categoria_nova: string | null;
  em: string | null;
}
export interface OverridesData {
  total: number;
  por_categoria: CardItem[];
  recentes: OverrideRecent[];
}
export interface SyncImport {
  confirmada_em: string | null;
  linhas: number;
  novos: number;
  existentes: number;
  duplicados: number;
  invalidos: number;
  conflitantes: number;
}
export interface SyncJob {
  status: string;
  iniciado_em: string | null;
  finalizado_em: string | null;
  lidos: number;
  criados: number;
  atualizados: number;
  falhas: number;
}
export interface SyncStatusData {
  ultima_importacao: SyncImport | null;
  ultimo_job: SyncJob | null;
  conflitos_pendentes: number;
}

interface Envelope {
  panelId: string;
  filtros: string[];
}
export type PanelPayload =
  | { tipo: "cartoes"; dados: CardsData }
  | { tipo: "tabela"; dados: TableData }
  | { tipo: "grafico"; dados: ChartData }
  | { tipo: "distribuicao"; dados: DistributionData }
  | { tipo: "ranking"; dados: RankingData }
  | { tipo: "razao"; dados: RatioData }
  | { tipo: "fila"; dados: QueueSummaryData }
  | { tipo: "lista"; dados: OverridesData }
  | { tipo: "status"; dados: SyncStatusData };
export type PanelData = Envelope & PanelPayload;

const isLabeled = (v: unknown): v is LabeledValue => isRec(v) && isStr(v.id) && isStr(v.label);
const isCardItem = (v: unknown): v is CardItem => isLabeled(v) && isInt((v as unknown as Rec).value);
const isValues = (v: unknown): v is Record<string, number> => isRec(v) && Object.values(v).every(isInt);
const isUnitRow = (v: unknown): v is UnitRow =>
  isRec(v) && isStr(v.unidade) && isInt(v.total) && isValues(v.valores);
const isShare = (v: unknown): v is Share =>
  isCardItem(v) && isNullable((v as unknown as Rec).percentual, isNum);
const isCategoryShare = (v: unknown): v is CategoryShare => isShare(v) && isStr((v as unknown as Rec).familia);

const isCards = (d: Rec): d is Rec & CardsData => isArr(d.itens, isCardItem) && isInt(d.total);
const isTable = (d: Rec): d is Rec & TableData => isArr(d.colunas, isLabeled) && isArr(d.linhas, isUnitRow) && isInt(d.total);
const isChart = (d: Rec): d is Rec & ChartData =>
  isStr(d.familia) && isStr(d.familia_label) && isArr(d.series, isLabeled) && isArr(d.unidades, isUnitRow) && isInt(d.total);
const isDistribution = (d: Rec): d is Rec & DistributionData =>
  isInt(d.total) && isArr(d.familias, isShare) && isArr(d.categorias, isCategoryShare);
const isRankingRow = (v: unknown): v is RankingRow =>
  isRec(v) && isStr(v.unidade) && isInt(v.notebooks) && isInt(v.docking) && isInt(v.sem_docking);
const isRanking = (d: Rec): d is Rec & RankingData =>
  isStr(d.metodo) && isInt(d.notebooks) && isInt(d.docking) && isInt(d.sem_docking) && isArr(d.por_unidade, isRankingRow);
const isRatio = (d: Rec): d is Rec & RatioData =>
  isInt(d.computadores) &&
  isInt(d.notebooks) &&
  isInt(d.monitores) &&
  isNullable(d.monitores_por_computador, isNum) &&
  isNullable(d.monitores_por_notebook, isNum);
const isQueueRow = (v: unknown): v is { unidade: string; value: number } =>
  isRec(v) && isStr(v.unidade) && isInt(v.value);
const isQueueSummary = (d: Rec): d is Rec & QueueSummaryData => isInt(d.total_pendentes) && isArr(d.por_unidade, isQueueRow);
const isRecent = (v: unknown): v is OverrideRecent =>
  isRec(v) &&
  isStr(v.asset_id) &&
  isStr(v.patrimony_number) &&
  isNullable(v.description, isStr) &&
  isNullable(v.categoria_anterior, isStr) &&
  isNullable(v.categoria_nova, isStr) &&
  isNullable(v.em, isStr);
const isOverrides = (d: Rec): d is Rec & OverridesData =>
  isInt(d.total) && isArr(d.por_categoria, isCardItem) && isArr(d.recentes, isRecent);
const isSyncImport = (v: unknown): v is SyncImport =>
  isRec(v) &&
  isNullable(v.confirmada_em, isStr) &&
  [v.linhas, v.novos, v.existentes, v.duplicados, v.invalidos, v.conflitantes].every(isInt);
const isSyncJob = (v: unknown): v is SyncJob =>
  isRec(v) &&
  isStr(v.status) &&
  isNullable(v.iniciado_em, isStr) &&
  isNullable(v.finalizado_em, isStr) &&
  [v.lidos, v.criados, v.atualizados, v.falhas].every(isInt);
const isSync = (d: Rec): d is Rec & SyncStatusData =>
  isNullable(d.ultima_importacao, isSyncImport) && isNullable(d.ultimo_job, isSyncJob) && isInt(d.conflitos_pendentes);

export function parsePanelData(raw: unknown, expectedId: string): PanelData {
  if (!isRec(raw) || raw.panel_id !== expectedId || !isStr(raw.tipo) || !isRec(raw.dados)) {
    throw new ContractError("painel");
  }
  const d = raw.dados;
  const filtros = isArr(raw.filtros_aplicados, isStr) ? raw.filtros_aplicados : [];
  const base = { panelId: expectedId, filtros };
  switch (raw.tipo) {
    case "cartoes":
      if (isCards(d)) return { ...base, tipo: "cartoes", dados: { itens: d.itens, total: d.total } };
      break;
    case "tabela":
      if (isTable(d)) return { ...base, tipo: "tabela", dados: { colunas: d.colunas, linhas: d.linhas, total: d.total } };
      break;
    case "grafico":
      if (isChart(d)) {
        return {
          ...base,
          tipo: "grafico",
          dados: { familia: d.familia, familia_label: d.familia_label, series: d.series, unidades: d.unidades, total: d.total },
        };
      }
      break;
    case "distribuicao":
      if (isDistribution(d)) {
        return { ...base, tipo: "distribuicao", dados: { total: d.total, familias: d.familias, categorias: d.categorias } };
      }
      break;
    case "ranking":
      if (isRanking(d)) {
        return {
          ...base,
          tipo: "ranking",
          dados: {
            metodo: d.metodo,
            notebooks: d.notebooks,
            docking: d.docking,
            sem_docking: d.sem_docking,
            por_unidade: d.por_unidade,
          },
        };
      }
      break;
    case "razao":
      if (isRatio(d)) {
        return {
          ...base,
          tipo: "razao",
          dados: {
            computadores: d.computadores,
            notebooks: d.notebooks,
            monitores: d.monitores,
            monitores_por_computador: d.monitores_por_computador,
            monitores_por_notebook: d.monitores_por_notebook,
          },
        };
      }
      break;
    case "fila":
      if (isQueueSummary(d)) {
        return { ...base, tipo: "fila", dados: { total_pendentes: d.total_pendentes, por_unidade: d.por_unidade } };
      }
      break;
    case "lista":
      if (isOverrides(d)) {
        return { ...base, tipo: "lista", dados: { total: d.total, por_categoria: d.por_categoria, recentes: d.recentes } };
      }
      break;
    case "status":
      if (isSync(d)) {
        return {
          ...base,
          tipo: "status",
          dados: { ultima_importacao: d.ultima_importacao, ultimo_job: d.ultimo_job, conflitos_pendentes: d.conflitos_pendentes },
        };
      }
      break;
    default:
      break;
  }
  throw new ContractError("painel");
}

const PANEL_ID_RE = /^[a-z_]{1,64}$/;

export async function getPanelData(panelId: string, filters: PanelFilters): Promise<PanelData> {
  if (!PANEL_ID_RE.test(panelId)) throw new ContractError("painel");
  const searchParams = panelFilterParams(filters);
  const raw = await apiClient.get<unknown>(`/v1/dashboard/panels/${panelId}/data`, { searchParams });
  return parsePanelData(raw, panelId);
}

export const panelDataQueryKey = (panelId: string, filters: PanelFilters) =>
  ["dashboard", "panel-data", panelId, panelFilterParams(filters)] as const;

export function usePanelData(
  panelId: string,
  filters: PanelFilters,
  enabled = true,
): UseQueryResult<PanelData, unknown> {
  return useQuery({
    queryKey: panelDataQueryKey(panelId, filters),
    queryFn: () => getPanelData(panelId, filters),
    enabled,
    staleTime: 60_000,
    retry: noRetryOn4xx,
  });
}

/** 404 = inexistente OU proibido (indistinguível): o painel só é ocultado. */
export const isHiddenPanelError = (error: unknown) => error instanceof ApiError && error.status === 404;

// ---------------------------------------------------------------------------
// Fila de revisão (ADM + AAL2)
// ---------------------------------------------------------------------------

export const REVIEW_SORT_VALUES = [
  "patrimony_number",
  "-patrimony_number",
  "description",
  "-description",
  "updated_at",
  "-updated_at",
] as const;
export type ReviewSort = (typeof REVIEW_SORT_VALUES)[number];

export interface ReviewItem {
  id: string;
  patrimony_number: string;
  description: string | null;
  unidade: string;
  equipment_category: string | null;
  classification_confidence: string | null;
  version: number;
}
export interface ReviewCategory {
  id: string;
  label: string;
  familia: string;
  familia_label: string;
}
export interface ReviewQueue {
  items: ReviewItem[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  categorias: ReviewCategory[];
}

export interface ReviewParams {
  page: number;
  pageSize: number;
  unitId?: string;
  sort: ReviewSort;
}

const isReviewItem = (v: unknown): v is ReviewItem =>
  isRec(v) &&
  isStr(v.id) &&
  isStr(v.patrimony_number) &&
  isNullable(v.description, isStr) &&
  isStr(v.unidade) &&
  isNullable(v.equipment_category, isStr) &&
  isNullable(v.classification_confidence, isStr) &&
  isInt(v.version);
const isReviewCategory = (v: unknown): v is ReviewCategory =>
  isRec(v) && isStr(v.id) && isStr(v.label) && isStr(v.familia) && isStr(v.familia_label);

export function parseReviewQueue(raw: unknown): ReviewQueue {
  if (
    !isRec(raw) ||
    !isArr(raw.items, isReviewItem) ||
    !isInt(raw.total) ||
    !isInt(raw.page) ||
    !isInt(raw.page_size) ||
    !isInt(raw.pages) ||
    !isArr(raw.categorias, isReviewCategory)
  ) {
    throw new ContractError("fila de revisão");
  }
  return {
    items: raw.items,
    total: raw.total,
    page: raw.page,
    page_size: raw.page_size,
    pages: raw.pages,
    categorias: raw.categorias,
  };
}

export async function getReviewQueue(params: ReviewParams): Promise<ReviewQueue> {
  const searchParams: Record<string, string | number> = {
    page: params.page,
    page_size: params.pageSize,
    sort: params.sort,
  };
  if (params.unitId) searchParams.unit_id = params.unitId;
  return parseReviewQueue(await apiClient.get<unknown>("/v1/dashboard/classificacao/revisao", { searchParams }));
}

export const reviewQueueKey = (params: ReviewParams) =>
  ["dashboard", "review-queue", params.page, params.pageSize, params.unitId ?? "", params.sort] as const;
export const REVIEW_QUEUE_PREFIX = ["dashboard", "review-queue"] as const;

export function useReviewQueue(params: ReviewParams, enabled = true): UseQueryResult<ReviewQueue, unknown> {
  return useQuery({
    queryKey: reviewQueueKey(params),
    queryFn: () => getReviewQueue(params),
    enabled,
    staleTime: 0,
    retry: noRetryOn4xx,
    placeholderData: (previous) => previous,
  });
}

export interface OverrideResult {
  id: string;
  version: number;
  categoria_efetiva: string | null;
}

/** `POST /assets/<id>/category-override`. Erros: ver `overrideErrorKind`. */
export async function overrideCategory(assetId: string, category: string, version: number): Promise<OverrideResult> {
  const raw = await apiClient.post<unknown>(`/v1/assets/${encodeURIComponent(assetId)}/category-override`, {
    category,
    version,
  });
  if (!isRec(raw) || !isStr(raw.id) || !isInt(raw.version) || !isNullable(raw.categoria_efetiva, isStr)) {
    throw new ContractError("correção de categoria");
  }
  return { id: raw.id, version: raw.version, categoria_efetiva: raw.categoria_efetiva };
}

export type OverrideErrorKind = "conflict" | "denied" | "other";

/** Classifica o erro SEM expor o detalhe do backend. */
export function overrideErrorKind(error: unknown): OverrideErrorKind {
  if (error instanceof ApiError) {
    if (error.status === 409) return "conflict";
    if (error.status === 403 || error.status === 404) return "denied";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Exportações (arquivo; Bearer via api-client, nunca token em URL)
// ---------------------------------------------------------------------------

export type ExportFormat = "csv" | "xlsx";
const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function exportFileName(prefix: string, format: ExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sispat-${prefix}-${stamp}.${format}`;
}

async function downloadFile(path: string, prefix: string, format: ExportFormat, params: Record<string, string>) {
  const { blob, contentType } = await requestFile(path, {
    searchParams: { ...params, format },
    accept: `${EXPORT_MIME[format]}, application/json;q=0.5`,
  });
  // Defesa: um 200 que não seja o arquivo esperado (ex.: página de proxy) não é salvo.
  if (!contentType.startsWith(EXPORT_MIME[format])) throw new ApiError("Resposta inesperada.", 502);
  const fileName = exportFileName(prefix, format);
  saveBlob(blob, fileName);
  return fileName;
}

/** Só para painéis com `exportable=true` no catálogo; o backend revalida. */
export function downloadPanelExport(panelId: string, format: ExportFormat, filters: PanelFilters): Promise<string> {
  if (!PANEL_ID_RE.test(panelId)) throw new ContractError("exportação");
  return downloadFile(
    `/v1/dashboard/panels/${panelId}/export`,
    panelId.replace(/_/g, "-"),
    format,
    panelFilterParams(filters),
  );
}

export function downloadReviewExport(format: ExportFormat, params: { unitId?: string; sort: ReviewSort }): Promise<string> {
  const query: Record<string, string> = { sort: params.sort };
  if (params.unitId) query.unit_id = params.unitId;
  return downloadFile("/v1/dashboard/classificacao/revisao/export", "revisao-classificacao", format, query);
}

/** Mensagem fixa (nunca a do backend). */
export function exportErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Seu perfil não tem permissão para exportar.";
    if (error.status === 429) return "Muitas exportações em pouco tempo. Aguarde e tente novamente.";
    if (error.status === 413) return "A exportação excede o limite de linhas. Refine os filtros.";
  }
  return "Não foi possível gerar o arquivo. Tente novamente.";
}

// ---------------------------------------------------------------------------
// Vocabulário de categorias (rótulos de filtro; o backend valida e responde 400
// a qualquer valor fora da allowlist — esta lista é só apresentação).
// ---------------------------------------------------------------------------

export const FAMILIA_LABEL: Record<FamiliaValue, string> = {
  TI: "Tecnologia da Informação",
  MOBILIARIO: "Mobiliário",
  OUTROS: "Outros",
  NAO_CLASSIFICADO: "Não classificado",
};

export interface CategoryOption {
  id: string;
  label: string;
  familia: FamiliaValue;
}

export const CATEGORY_OPTIONS: readonly CategoryOption[] = [
  { id: "COMPUTADOR", label: "Computador", familia: "TI" },
  { id: "NOTEBOOK", label: "Notebook", familia: "TI" },
  { id: "MONITOR", label: "Monitor", familia: "TI" },
  { id: "IMPRESSORA", label: "Impressora", familia: "TI" },
  { id: "NOBREAK", label: "Nobreak", familia: "TI" },
  { id: "ESTABILIZADOR", label: "Estabilizador", familia: "TI" },
  { id: "DOCKING", label: "Docking station", familia: "TI" },
  { id: "REDE", label: "Rede", familia: "TI" },
  { id: "OUTRO_TI", label: "Outro item de TI", familia: "TI" },
  { id: "MESA", label: "Mesa", familia: "MOBILIARIO" },
  { id: "ARMARIO", label: "Armário", familia: "MOBILIARIO" },
  { id: "GAVETEIRO", label: "Gaveteiro", familia: "MOBILIARIO" },
  { id: "ESTACAO_TRABALHO", label: "Estação de trabalho", familia: "MOBILIARIO" },
  { id: "CADEIRA", label: "Cadeira", familia: "MOBILIARIO" },
  { id: "POLTRONA", label: "Poltrona", familia: "MOBILIARIO" },
  { id: "SOFA", label: "Sofá", familia: "MOBILIARIO" },
  { id: "ESTANTE", label: "Estante", familia: "MOBILIARIO" },
  { id: "OUTRO_MOB", label: "Outro mobiliário", familia: "MOBILIARIO" },
  { id: "EQUIPAMENTO", label: "Equipamento", familia: "OUTROS" },
  { id: "OUTROS", label: "Outros", familia: "OUTROS" },
  { id: "NAO_CLASSIFICADO", label: "Não classificado", familia: "NAO_CLASSIFICADO" },
];
