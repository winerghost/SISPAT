// =============================================================================
// SISPAT-AGU — catalog-imports-api.ts
// =============================================================================
// Importação dos CADASTROS de apoio (unidades, salas, pessoas) a partir do
// Google Sheets: prévia → revisão → confirmação. Contrato:
// docs/architecture/cadastros-apoio-api.md ("Importação dos cadastros").
// Só transporte: perfil, AAL2, permissão do tipo, escopo e idempotência são
// decididos pelo backend.
//
// LGPD: o telefone NUNCA chega (só `has_phone`) e o e-mail vem mascarado
// (`c***@agu.gov.br`). Nada daqui vai para URL, storage ou console; o cache do
// TanStack Query vive só em memória.
//
// Caminhos começam em `/v1/...` (NEXT_PUBLIC_API_URL já inclui `/api`).
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";
import type { ImportItemClassification, ImportPreviewSummary } from "@/lib/imports-api";

export type CatalogImportKind = "units" | "rooms" | "people";

export const CATALOG_IMPORT_KINDS: readonly CatalogImportKind[] = ["units", "rooms", "people"];

/** Ordenações aceitas (allowlist do backend). */
export type CatalogImportSort =
  | "label"
  | "-label"
  | "classification"
  | "-classification"
  | "source_id"
  | "-source_id";

export interface CatalogImportSuspectedName {
  row: number | null;
  name: string | null;
  /** Motivos (texto curto do backend) — lista ou texto único. */
  reasons: string[] | string | null;
}

export interface CatalogImportReport {
  kind: CatalogImportKind;
  total: number;
  classificacoes: Partial<Record<ImportItemClassification, number>>;
  /** Código da pendência → quantidade de linhas. */
  pendencias: Record<string, number>;
  ids_repetidos: { id: string; linhas: (number | null)[] }[];
  nomes_suspeitos: CatalogImportSuspectedName[];
  provaveis_duplicatas: { names: (string | null)[]; rows: (number | null)[] }[];
}

export interface CatalogImportPreviewResponse {
  preview_id: string;
  kind: CatalogImportKind;
  summary: ImportPreviewSummary;
  expires_at: string;
  report: CatalogImportReport;
}

/** Campos de `details` expostos pelo backend (allowlist; sem telefone). */
export interface CatalogImportItemDetails {
  unidade_sigla?: string | null;
  unit_code?: string | null;
  unit_name?: string | null;
  room_name?: string | null;
  probable_duplicate?: boolean | null;
  person_name?: string | null;
  suspect?: string[] | string | null;
  /** E-mail já mascarado pelo backend. */
  email_masked?: string | null;
  has_email?: boolean;
  has_phone?: boolean;
  /**
   * Só unidades: true = a confirmação PODE criar o alias da sigla (opt-in do ADM
   * via `alias_item_ids`). Ausente/false = nenhum alias possível para o item.
   */
  create_alias?: boolean;
}

export interface CatalogImportItem {
  id: string;
  row: number | null;
  source_record_id: string | null;
  label: string | null;
  classification: ImportItemClassification;
  selected: boolean;
  existing: boolean;
  id_conflict: boolean;
  /** Códigos de pendência da linha. */
  pendencias: string[];
  validation_errors: string[];
  details: CatalogImportItemDetails;
}

export interface CatalogImportItemsResponse {
  preview_id: string;
  kind: CatalogImportKind;
  total: number;
  page: number;
  page_size: number;
  items: CatalogImportItem[];
}

export interface CatalogImportItemsParams {
  status?: ImportItemClassification;
  /** Até 100 caracteres. */
  search?: string;
  sort?: CatalogImportSort;
  page?: number;
  /** 50, 100 ou 200. */
  page_size?: number;
}

export interface CatalogImportFailure {
  item_id: string | null;
  row: number | null;
  label: string | null;
  reason: string | null;
}

export interface CatalogImportConfirmResponse {
  preview_id: string;
  kind: CatalogImportKind;
  sync_job_id: string;
  created: number;
  updated: number;
  ignorados: number;
  falhas: CatalogImportFailure[];
}

/** Máximo de `item_ids` aceito pelo backend por confirmação. */
export const CATALOG_CONFIRM_MAX_IDS = 10_000;

const BASE = "/v1/catalog-imports";

/** `POST /catalog-imports/<kind>/preview` — sem corpo. */
export function createCatalogImportPreview(kind: CatalogImportKind): Promise<CatalogImportPreviewResponse> {
  return apiClient.post<CatalogImportPreviewResponse>(`${BASE}/${encodeURIComponent(kind)}/preview`);
}

/** `GET /catalog-imports/<preview_id>/items`. */
export function getCatalogImportItems(
  previewId: string,
  params: CatalogImportItemsParams = {},
): Promise<CatalogImportItemsResponse> {
  return apiClient.get<CatalogImportItemsResponse>(`${BASE}/${encodeURIComponent(previewId)}/items`, {
    searchParams: {
      status: params.status,
      search: params.search?.trim() || undefined,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

export interface CatalogImportConfirmPayload {
  item_ids: string[];
  /** Subconjunto de `item_ids` que o ADM aceitou criar a sigla de atalho (omitido se vazio). */
  alias_item_ids?: string[];
}

/** Monta o corpo da confirmação: `alias_item_ids` só vai se houver itens optados. */
export function buildConfirmPayload(itemIds: string[], aliasItemIds: string[] = []): CatalogImportConfirmPayload {
  const chosen = new Set(itemIds);
  const aliases = aliasItemIds.filter((id) => chosen.has(id));
  return aliases.length > 0 ? { item_ids: itemIds, alias_item_ids: aliases } : { item_ids: itemIds };
}

/**
 * `POST /catalog-imports/<preview_id>/confirm` — gravação em massa (idempotente).
 * Sem `aliasItemIds` nenhum alias de sigla é criado (SEC-CAT-04).
 */
export function confirmCatalogImport(
  previewId: string,
  itemIds: string[],
  aliasItemIds: string[] = [],
): Promise<CatalogImportConfirmResponse> {
  return apiClient.post<CatalogImportConfirmResponse>(
    `${BASE}/${encodeURIComponent(previewId)}/confirm`,
    buildConfirmPayload(itemIds, aliasItemIds),
  );
}

export { ApiError };
