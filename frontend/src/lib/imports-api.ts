// =============================================================================
// SISPAT-AGU — imports-api.ts
// =============================================================================
// Funções tipadas para o fluxo de importação via Google Sheets, consumindo o
// `apiClient` já existente (ver `@/lib/api-client`). Nenhuma lógica de rede
// é reimplementada aqui — apenas o contrato de tipos e os caminhos do
// backend (ver `backend/app/api/v1/imports.py`, 59/59 testes passando).
//
// Observação sobre caminhos: `NEXT_PUBLIC_API_URL` já inclui o prefixo
// `/api` (ver `.env.example`), e as rotas do backend vivem sob
// `/api/v1/imports/...`. Por isso os caminhos abaixo começam em `/v1/...`
// (sem repetir `/api`) — ver `buildUrl` em `api-client.ts`.
//
// Autenticação: todos os endpoints exigem usuário ADM com a permissão
// `imports.execute` (`Authorization: Bearer <token>`), anexado
// automaticamente pelo `apiClient` a partir da sessão Supabase atual.
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";

const BASE_PATH = "/v1/imports/google-sheets";
/** Timeout do cliente para a prévia: acima do teto do backend (~120 s). */
const PREVIEW_TIMEOUT_MS = 150_000;

export type ImportItemClassification =
  | "NOVO"
  | "EXISTENTE"
  | "DUPLICADO"
  | "INVALIDO"
  | "CONFLITANTE";

export interface ImportPreviewSummary {
  total: number;
  novo: number;
  existente: number;
  duplicado: number;
  invalido: number;
  conflitante: number;
}

export interface ImportPreviewResponse {
  preview_id: string;
  summary: ImportPreviewSummary;
  expires_at: string;
  /** Pendências de vínculo (código → linhas). Só contadores; nunca bloqueiam. Ausente em backends antigos. */
  pending_counts?: Record<string, number>;
}

export interface ImportPendingReport {
  preview_id: string;
  pending_counts: Record<string, number>;
}

export interface ImportPreviewItem {
  id: string;
  source_record_id: string;
  patrimony_number: string;
  description: string;
  classification: ImportItemClassification;
  selected: boolean;
  validation_errors: string[] | null;
}

export interface ImportPreviewItemsResponse {
  total: number;
  page: number;
  page_size: number;
  items: ImportPreviewItem[];
}

export interface ImportPreviewItemsParams {
  status?: ImportItemClassification;
  search?: string;
  page?: number;
  page_size?: number;
}

/** Limite do backend para `excluded_item_ids` / `selected_item_ids`. */
export const IMPORT_MAX_ITEM_IDS = 10_000;

/**
 * Confirmação. Modo "todos os elegíveis" (padrão da tela): `select_all_eligible`
 * + `excluded_item_ids` (desmarcados; a exclusão sempre vence). Modo explícito:
 * `selected_item_ids`. O backend valida e decide; a tela só descreve a intenção.
 */
export interface ImportConfirmRequest {
  preview_id: string;
  selected_item_ids?: string[];
  select_all_eligible?: boolean;
  excluded_item_ids?: string[];
}

/** Motivo de itens não importados (reconciliação). */
export interface ImportReconciliationItem {
  row: number | null;
  patrimony_number: string | null;
  classification: ImportItemClassification | string;
  reason_code: string | null;
}

export interface ImportReconciliationResponse {
  total_itens: number;
  localizados: number;
  nao_importados: number;
  por_motivo: Record<string, number>;
  items: ImportReconciliationItem[];
  /** Total de `items` para paginação (ausente = `nao_importados`). */
  total?: number;
  page?: number;
  page_size?: number;
}

export interface ImportReconciliationParams {
  reason?: string;
  page?: number;
  page_size?: number;
}

/** Falha de um item de bens (sem descrição/PII): linha, número patrimonial (TEXTO) e motivo fixo. */
export interface ImportConfirmFailureItem {
  item_id: string | null;
  row: number | null;
  patrimony_number: string | null;
  reason: string | null;
}

/** Itens da prévia que a confirmação NÃO grava (só contadores; sem PII). */
export interface ImportConfirmUnwritten {
  total: number;
  /** DUPLICADO / INVALIDO / CONFLITANTE → quantidade. */
  por_classificacao: Record<string, number>;
  /** Código do motivo (pendência, `duplicado_na_origem`, ...) → quantidade. */
  por_motivo: Record<string, number>;
  /** NOVO/EXISTENTE que o ADM desmarcou. */
  nao_selecionados: number;
}

/** Mesmo contrato da confirmação dos cadastros (D2): status do job e totais reais. */
export interface ImportConfirmResponse {
  sync_job_id: string;
  /** Status do SyncJob gravado pelo backend. */
  status: "CONCLUIDO" | "PARCIAL" | "FALHOU";
  created: number;
  updated: number;
  ignorados: number;
  /** EXISTENTE sem diferença com a planilha (nada gravado). */
  inalterados: number;
  nao_gravados: ImportConfirmUnwritten;
  /** Pendências de vínculo dos bens CRIADOS (sala, pessoa, unidade pertencente...). */
  pendencias_vinculo: Record<string, number>;
  /** Total de falhas (a lista `falhas` traz no máximo 100). */
  falhas_total: number;
  falhas: ImportConfirmFailureItem[];
  /** O backend gravou, mas falhou ao validar a resposta: só os contadores valem. */
  degraded: boolean;
}

/** `POST /api/v1/imports/google-sheets/preview` — gera uma nova prévia. */
export function createGoogleSheetsPreview(): Promise<ImportPreviewResponse> {
  // Prévia grande (~1000 linhas) lê o Sheets no backend (até ~120 s): o
  // timeout do cliente precisa ser maior para não abortar antes dele.
  return apiClient.post<ImportPreviewResponse>(`${BASE_PATH}/preview`, undefined, {
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
}

/** `GET /api/v1/imports/google-sheets/preview/{preview_id}/items` — lista paginada/filtrada. */
export function getGoogleSheetsPreviewItems(
  previewId: string,
  params: ImportPreviewItemsParams = {},
): Promise<ImportPreviewItemsResponse> {
  return apiClient.get<ImportPreviewItemsResponse>(
    `${BASE_PATH}/preview/${encodeURIComponent(previewId)}/items`,
    {
      searchParams: {
        status: params.status,
        search: params.search || undefined,
        page: params.page,
        page_size: params.page_size,
      },
    },
  );
}

/** `POST /api/v1/imports/google-sheets/confirm` — confirma a importação dos itens selecionados. */
export function confirmGoogleSheetsImport(
  payload: ImportConfirmRequest,
): Promise<ImportConfirmResponse> {
  return apiClient.post<ImportConfirmResponse>(`${BASE_PATH}/confirm`, payload);
}

/** `GET /api/v1/imports/google-sheets/{preview_id}/pending` — contadores de pendências de vínculo. */
export function getGoogleSheetsPendingReport(previewId: string): Promise<ImportPendingReport> {
  return apiClient.get<ImportPendingReport>(`${BASE_PATH}/${encodeURIComponent(previewId)}/pending`);
}

/** `GET /api/v1/imports/google-sheets/{preview_id}/reconciliation` — só ADM. */
export function getGoogleSheetsReconciliation(
  previewId: string,
  params: ImportReconciliationParams = {},
): Promise<ImportReconciliationResponse> {
  return apiClient.get<ImportReconciliationResponse>(
    `${BASE_PATH}/${encodeURIComponent(previewId)}/reconciliation`,
    { searchParams: { reason: params.reason || undefined, page: params.page, page_size: params.page_size } },
  );
}

export { ApiError };
