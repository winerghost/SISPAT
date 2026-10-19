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

export interface ImportConfirmRequest {
  preview_id: string;
  selected_item_ids: string[];
}

export interface ImportConfirmFailureItem {
  [key: string]: unknown;
}

export interface ImportConfirmResponse {
  sync_job_id: string;
  created: number;
  updated: number;
  ignorados: number;
  falhas: ImportConfirmFailureItem[];
}

/** `POST /api/v1/imports/google-sheets/preview` — gera uma nova prévia. */
export function createGoogleSheetsPreview(): Promise<ImportPreviewResponse> {
  return apiClient.post<ImportPreviewResponse>(`${BASE_PATH}/preview`);
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

export { ApiError };
