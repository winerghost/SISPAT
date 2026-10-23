// =============================================================================
// SISPAT-AGU — assets-api.ts
// =============================================================================
// Tipos e chamadas da API de patrimônios (`/api/v1/assets`). Contrato:
// docs/architecture/assets-api.md. Só transporte: perfil, escopo de unidade,
// AAL2, unicidade do número, vínculos e concorrência (`version`) são decididos
// pelo backend Flask.
//
// - O número patrimonial é TEXTO (zeros à esquerda preservados): nunca passa por
//   Number/parseInt nem por formatação numérica.
// - Chaves ausentes (RH não recebe `notes`, `created_by` etc.) simplesmente não
//   existem no objeto: a UI testa a presença da CHAVE.
// - Não existe DELETE: excluir/restaurar são `POST .../delete|restore` (lógico).
// - Caminhos começam em `/v1/...`; IDs sempre com `encodeURIComponent`.
// =============================================================================

import { apiClient } from "@/lib/api-client";

export type LocatedStatus = "SIM" | "NAO" | "DESCONHECIDO";

export type AssetCategory = "TECNOLOGIA" | "MOBILIARIO" | "VEICULO" | "EQUIPAMENTO" | "OUTROS";
export type TechType = "COMPUTADOR" | "NOTEBOOK" | "MONITOR" | "IMPRESSORA" | "OUTRO_TI";
export type OperationalStatus = "EM_USO" | "ESTOQUE" | "MANUTENCAO" | "BAIXADO";

export interface AssetUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface AssetNamedRef {
  id: string;
  name: string;
}

export interface AssetRecord {
  id: string;
  patrimony_number: string;
  description: string | null;
  unit_id: string;
  unit: AssetUnitRef;
  owner_unit_id: string | null;
  owner_unit: AssetUnitRef | null;
  responsible_person_id: string | null;
  responsible_person: AssetNamedRef | null;
  room_id: string | null;
  room: AssetNamedRef | null;
  location_id: string | null;
  location: AssetNamedRef | null;
  located: LocatedStatus;
  /** Classificação (null = não informado). Editável por ADM/USER via PATCH. */
  asset_category?: AssetCategory | null;
  /** Só com categoria TECNOLOGIA. */
  tech_type?: TechType | null;
  operational_status?: OperationalStatus | null;
  /**
   * Vínculo do bem (1ª coluna RESPONSAVEL da planilha: "Servidor",
   * "Terceirizado", "Ocioso"...). Somente leitura: vem da importação, nunca do
   * formulário. Texto livre importado — exibido só como texto (React escapa).
   */
  bond_status: string | null;
  /** AAAA-MM-DD (data de calendário, sem fuso). */
  registration_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  version: number;
  /** ADM e USER; ausente para RH. */
  notes?: string | null;
}

export type AssetSort =
  | "patrimony_number"
  | "-patrimony_number"
  | "description"
  | "-description"
  | "bond_status"
  | "-bond_status"
  | "created_at"
  | "-created_at"
  | "updated_at"
  | "-updated_at";

export interface AssetListParams {
  q?: string;
  unit_id?: string;
  room_id?: string;
  responsible_person_id?: string;
  located?: LocatedStatus;
  /** Vínculo (sem distinguir caixa no backend); `BOND_STATUS_NONE` = sem vínculo. */
  bond_status?: string;
  /** Só ADM (USER/RH recebem 403). */
  include_deleted?: boolean;
  sort?: AssetSort;
  page?: number;
  /** 50, 100 ou 200 (padrão do backend: 50). */
  page_size?: number;
}

export interface AssetsListResponse {
  total: number;
  page: number;
  page_size: number;
  assets: AssetRecord[];
}

/** Criação (`extra="forbid"`). `owner_unit_id` e `located` só ADM. */
export interface CreateAssetRequest {
  unit_id: string;
  patrimony_number: string;
  description?: string | null;
  notes?: string | null;
  responsible_person_id?: string | null;
  room_id?: string | null;
  location_id?: string | null;
  registration_date?: string | null;
  owner_unit_id?: string | null;
  located?: LocatedStatus;
}

/** PATCH: `version` + ao menos um campo; `null` limpa opcionais. */
export interface UpdateAssetRequest {
  version: number;
  patrimony_number?: string;
  description?: string | null;
  notes?: string | null;
  responsible_person_id?: string | null;
  room_id?: string | null;
  location_id?: string | null;
  registration_date?: string | null;
  owner_unit_id?: string | null;
  located?: LocatedStatus;
  /** `null` = "não informado". `tech_type` exige categoria TECNOLOGIA (422). */
  asset_category?: AssetCategory | null;
  tech_type?: TechType | null;
  operational_status?: OperationalStatus | null;
}

export interface AssetActionRequest {
  version: number;
  /** Até 500 caracteres (auditoria). */
  reason?: string;
}

export interface AssetHistoryEntry {
  id: string;
  operation: string;
  occurred_at: string;
  /** Apenas o identificador (sem nome/e-mail). */
  actor_user_id: string | null;
  result: string;
  previous_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export interface AssetHistoryResponse {
  total: number;
  page: number;
  page_size: number;
  entries: AssetHistoryEntry[];
}

const ASSETS = "/v1/assets";

function itemPath(id: string, suffix = ""): string {
  return `${ASSETS}/${encodeURIComponent(id)}${suffix}`;
}

export function listAssets(params: AssetListParams = {}): Promise<AssetsListResponse> {
  return apiClient.get<AssetsListResponse>(ASSETS, {
    searchParams: {
      q: params.q?.trim() || undefined,
      unit_id: params.unit_id || undefined,
      room_id: params.room_id || undefined,
      responsible_person_id: params.responsible_person_id || undefined,
      located: params.located,
      bond_status: params.bond_status || undefined,
      // Padrão do backend é `false`: só envia quando verdadeiro.
      include_deleted: params.include_deleted ? "true" : undefined,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

// -----------------------------------------------------------------------------
// Opções do filtro "Vínculo" (`GET /v1/assets/bond-statuses`, escopo do usuário)
// -----------------------------------------------------------------------------

/** Valor reservado do filtro: bens sem vínculo (`bond_status` nulo). */
export const BOND_STATUS_NONE = "__none__";

export interface AssetBondStatusOption {
  value: string;
  count: number;
}

export interface AssetBondStatusesResponse {
  items: AssetBondStatusOption[];
}

/** Limites defensivos: resposta fora do formato é REJEITADA (o filtro fica indisponível). */
const BOND_STATUS_MAX_ITEMS = 200;
const BOND_STATUS_MAX_TEXT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBondStatusOption(value: unknown): value is AssetBondStatusOption {
  if (!isRecord(value)) return false;
  const { value: text, count } = value;
  return (
    typeof text === "string" &&
    text.trim().length > 0 &&
    text.length <= BOND_STATUS_MAX_TEXT &&
    text !== BOND_STATUS_NONE &&
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count >= 0
  );
}

export function isAssetBondStatusesResponse(value: unknown): value is AssetBondStatusesResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.length <= BOND_STATUS_MAX_ITEMS &&
    value.items.every(isBondStatusOption)
  );
}

export async function fetchAssetBondStatuses(): Promise<AssetBondStatusesResponse> {
  const data = await apiClient.get<unknown>(`${ASSETS}/bond-statuses`);
  if (!isAssetBondStatusesResponse(data)) throw new Error("Resposta de vínculos inválida.");
  // Cópia só com as chaves conhecidas (nada além do contrato chega à UI).
  return { items: data.items.map(({ value, count }) => ({ value, count })) };
}

export function getAsset(id: string, options: { includeDeleted?: boolean } = {}): Promise<AssetRecord> {
  return apiClient.get<AssetRecord>(itemPath(id), {
    searchParams: { include_deleted: options.includeDeleted ? "true" : undefined },
  });
}

export function createAsset(payload: CreateAssetRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(ASSETS, payload);
}

export function updateAsset(id: string, payload: UpdateAssetRequest): Promise<AssetRecord> {
  return apiClient.patch<AssetRecord>(itemPath(id), payload);
}

export function deleteAsset(id: string, payload: AssetActionRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(itemPath(id, "/delete"), payload);
}

export function restoreAsset(id: string, payload: AssetActionRequest): Promise<AssetRecord> {
  return apiClient.post<AssetRecord>(itemPath(id, "/restore"), payload);
}

export function getAssetHistory(
  id: string,
  params: { page?: number; page_size?: number; includeDeleted?: boolean } = {},
): Promise<AssetHistoryResponse> {
  return apiClient.get<AssetHistoryResponse>(itemPath(id, "/history"), {
    searchParams: {
      page: params.page,
      page_size: params.page_size,
      include_deleted: params.includeDeleted ? "true" : undefined,
    },
  });
}
