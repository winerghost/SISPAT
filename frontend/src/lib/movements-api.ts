// =============================================================================
// SISPAT-AGU — movements-api.ts
// =============================================================================
// Tipos e chamadas da API de movimentações (`/api/v1/movements`). Contrato:
// docs/architecture/movements-api.md. Só transporte: perfil, escopo de unidade,
// AAL2, transições de estado, vínculos e concorrência (`asset_version`) são
// decididos pelo backend Flask.
//
// - O histórico é IMUTÁVEL: não existe PUT/PATCH/DELETE de movimentação. Só
//   solicitar (POST) e as transições únicas approve/reject/cancel.
// - Chaves ausentes (RH não recebe `reason`, `requested_by`, `approved_by`; quem só
//   tem escopo no DESTINO não recebe `origin_room*`, `previous_responsible*` nem
//   `reason`) simplesmente não existem no objeto: a UI testa a presença da CHAVE
//   e nunca trata ausência como "sem sala"/"sem responsável".
// - Número patrimonial é TEXTO. IDs sempre com `encodeURIComponent`.
// =============================================================================

import { apiClient } from "@/lib/api-client";

/** `CONCLUIDA` existe no banco, mas o backend não a usa (aprovar grava `completed_at`). */
export type MovementStatus = "PENDENTE" | "APROVADA" | "REJEITADA" | "CANCELADA" | "CONCLUIDA";

export type MovementType = "TRANSFERENCIA_UNIDADE" | "MUDANCA_SALA" | "TROCA_RESPONSAVEL";

export interface MovementUnitRef {
  id: string;
  code: string;
  name: string;
}

export interface MovementNamedRef {
  id: string;
  name: string;
}

export interface MovementAssetRef {
  id: string;
  patrimony_number: string;
  description: string | null;
  deleted: boolean;
}

export interface MovementRecord {
  id: string;
  asset_id: string;
  asset: MovementAssetRef | null;
  movement_type: MovementType | string;
  status: MovementStatus;
  origin_unit_id: string | null;
  origin_unit: MovementUnitRef | null;
  destination_unit_id: string | null;
  destination_unit: MovementUnitRef | null;
  /** Ausentes (chave inexistente, não null) quando a unidade de origem está fora do escopo do leitor. */
  origin_room_id?: string | null;
  origin_room?: MovementNamedRef | null;
  destination_room_id: string | null;
  destination_room: MovementNamedRef | null;
  /** Ausentes (chave inexistente) quando a origem está fora do escopo do leitor. */
  previous_responsible_id?: string | null;
  previous_responsible?: MovementNamedRef | null;
  new_responsible_id: string | null;
  new_responsible: MovementNamedRef | null;
  created_at: string | null;
  approved_at: string | null;
  completed_at: string | null;
  /** ADM e USER; ausentes para RH e para quem só tem escopo no destino. */
  reason?: string | null;
  requested_by?: string | null;
  approved_by?: string | null;
}

export type MovementSort = "created_at" | "-created_at" | "status" | "-status";

export interface MovementListParams {
  status?: Exclude<MovementStatus, "CONCLUIDA">;
  asset_id?: string;
  origin_unit_id?: string;
  destination_unit_id?: string;
  /** AAAA-MM-DD (UTC). */
  created_from?: string;
  /** AAAA-MM-DD (UTC, inclusivo). */
  created_to?: string;
  sort?: MovementSort;
  page?: number;
  /** 1 a 100 (padrão do backend: 25). */
  page_size?: number;
}

export interface MovementsListResponse {
  total: number;
  page: number;
  page_size: number;
  movements: MovementRecord[];
}

/**
 * Solicitação (`extra="forbid"`). Sala/responsável: ausente em unidade diferente
 * = vazio; ausente na MESMA unidade = mantém; `null` explícito = limpa.
 */
export interface CreateMovementRequest {
  asset_id: string;
  asset_version: number;
  destination_unit_id: string;
  destination_room_id?: string | null;
  new_responsible_id?: string | null;
  /** Até 500 caracteres. */
  reason?: string;
}

export interface ApproveMovementRequest {
  /** Versão do bem que o aprovador está vendo. */
  asset_version: number;
}

export interface MovementDecisionRequest {
  /** Até 500 caracteres (vai só para a auditoria). */
  reason?: string;
}

const MOVEMENTS = "/v1/movements";

function itemPath(id: string, suffix = ""): string {
  return `${MOVEMENTS}/${encodeURIComponent(id)}${suffix}`;
}

export function listMovements(params: MovementListParams = {}): Promise<MovementsListResponse> {
  return apiClient.get<MovementsListResponse>(MOVEMENTS, {
    searchParams: {
      status: params.status,
      asset_id: params.asset_id || undefined,
      origin_unit_id: params.origin_unit_id || undefined,
      destination_unit_id: params.destination_unit_id || undefined,
      created_from: params.created_from || undefined,
      created_to: params.created_to || undefined,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

export function getMovement(id: string): Promise<MovementRecord> {
  return apiClient.get<MovementRecord>(itemPath(id));
}

export function createMovement(payload: CreateMovementRequest): Promise<MovementRecord> {
  return apiClient.post<MovementRecord>(MOVEMENTS, payload);
}

export function approveMovement(id: string, payload: ApproveMovementRequest): Promise<MovementRecord> {
  return apiClient.post<MovementRecord>(itemPath(id, "/approve"), payload);
}

export function rejectMovement(id: string, payload: MovementDecisionRequest): Promise<MovementRecord> {
  return apiClient.post<MovementRecord>(itemPath(id, "/reject"), payload);
}

export function cancelMovement(id: string, payload: MovementDecisionRequest): Promise<MovementRecord> {
  return apiClient.post<MovementRecord>(itemPath(id, "/cancel"), payload);
}
