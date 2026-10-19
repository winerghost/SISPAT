// =============================================================================
// Rótulos, formatação e mensagens FIXAS da tela de Movimentações.
// =============================================================================
// Nunca exibimos `error.message` vindo da API: cada status/código do contrato
// (docs/architecture/movements-api.md) vira uma frase humana fixa. 404 não vaza
// detalhe (movimentação/bem alheio, inexistente ou malformado = mesma resposta).
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { MovementRecord, MovementStatus } from "@/lib/movements-api";
import { AAL2_MESSAGE, errorCode, formatDateTime } from "@/components/features/users/user-labels";

export { formatDateTime };

export const movementsQueryKey = ["movements"] as const;
export const movementListKey = (params: unknown) => [...movementsQueryKey, "list", params] as const;
export const movementDetailKey = (id: string) => [...movementsQueryKey, "detail", id] as const;

export const MOVEMENT_PAGE_SIZE = 25;
export const REASON_MAX = 500;
export const ASSET_PICK_PAGE_SIZE = 10;
export const ASSET_SEARCH_MAX = 100;

export const STATUS_LABEL: Record<MovementStatus, string> = {
  PENDENTE: "Pendente",
  APROVADA: "Aprovada",
  REJEITADA: "Rejeitada",
  CANCELADA: "Cancelada",
  CONCLUIDA: "Concluída",
};

/** Filtros oferecidos (CONCLUIDA existe no banco, mas o backend não a usa). */
export const STATUS_OPTIONS = ["PENDENTE", "APROVADA", "REJEITADA", "CANCELADA"] as const;

export const TYPE_LABEL: Record<string, string> = {
  TRANSFERENCIA_UNIDADE: "Transferência de unidade",
  MUDANCA_SALA: "Mudança de sala",
  TROCA_RESPONSAVEL: "Troca de responsável",
};

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? "Movimentação";
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as MovementStatus] ?? "Estado desconhecido";
}

export const MOVEMENT_VERSION_CONFLICT_MESSAGE =
  "O bem foi alterado por outra pessoa desde que esta tela carregou. Os dados foram recarregados — revise e tente de novo.";

export const MOVEMENT_STALE_MESSAGE =
  "Esta movimentação mudou desde que foi carregada (outra pessoa a decidiu ou ela deixou de existir no seu escopo). Os dados foram recarregados.";

export const MOVEMENT_NOT_FOUND_MESSAGE = "Movimentação não encontrada, ou fora do seu escopo de unidades.";

export const MOVEMENT_LOOKUPS_ERROR_MESSAGE =
  "Não foi possível carregar as unidades para os filtros. A listagem continua disponível.";

export function isMovementVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === "version_conflict";
}

export function isMovementNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

const CONFLICT_MESSAGES: Record<string, string> = {
  version_conflict: MOVEMENT_VERSION_CONFLICT_MESSAGE,
  movement_pending: "Este bem já tem uma movimentação pendente. Aguarde a decisão ou cancele a solicitação existente.",
  no_change:
    "A movimentação não mudaria nada no bem (mesma unidade, sala e responsável). Escolha um destino diferente.",
  invalid_transition:
    "Esta movimentação não está mais pendente: já foi aprovada, rejeitada ou cancelada. Os dados foram recarregados.",
  asset_unavailable: "O bem não está mais disponível (foi excluído). A movimentação não pode ser aplicada.",
  unit_inactive: "A unidade de destino está inativa. Escolha uma unidade ativa.",
  link_inactive: "A sala ou o responsável escolhido está inativo. Escolha um vínculo ativo da unidade de destino.",
  link_unit_mismatch:
    "A sala ou o responsável escolhido não pertence à unidade de destino. Escolha vínculos da unidade de destino.",
};

/** Mensagem humana para qualquer erro de escrita. `fallback` descreve a ação que falhou. */
export function movementErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para esta ação, ou ela exige acesso à origem e ao destino.";
  if (error.status === 404) return MOVEMENT_NOT_FOUND_MESSAGE;
  if (error.status === 409) {
    return (code ? CONFLICT_MESSAGES[code] : undefined) ?? "A ação conflita com o estado atual. Recarregue e tente de novo.";
  }
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 400) return "Os dados enviados não foram aceitos. Revise os campos e tente novamente.";
  return fallback;
}

/** Mensagem da listagem/detalhe (sem expor detalhe do backend). */
export function movementListErrorMessage(error: unknown): string {
  const fallback = "Não foi possível carregar as movimentações. Tente novamente.";
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (errorCode(error) === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para consultar as movimentações.";
  if (error.status === 404) return "Nada foi encontrado no seu escopo de unidades.";
  if (error.status === 400) return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  if (error.status === 429) return rateLimitMessage(error);
  return fallback;
}

export function unitRefText(unit: { code: string; name: string } | null | undefined): string {
  return unit ? `${unit.code} — ${unit.name}` : "—";
}

/** Lado da origem fora do escopo do leitor: o backend omite sala/responsável (chave ausente). */
export const SIDE_HIDDEN_TEXT = "indisponível (fora do seu escopo)";

/** Texto claro "unidade · sala · responsável" de um dos lados da movimentação. */
export function sideSummary(
  unit: { code: string; name: string } | null | undefined,
  room: { name: string } | null | undefined,
  person: { name: string } | null | undefined,
  /** `false` = a CHAVE de sala/responsável não veio (escopo): não é "sem sala". */
  known: { room?: boolean; person?: boolean } = {},
): { unit: string; room: string; person: string } {
  const roomKnown = known.room ?? true;
  const personKnown = known.person ?? true;
  return {
    unit: unitRefText(unit),
    room: roomKnown ? (room?.name ?? "sem sala") : SIDE_HIDDEN_TEXT,
    person: personKnown ? (person?.name ?? "sem responsável") : SIDE_HIDDEN_TEXT,
  };
}

/** A origem só tem sala/responsável visíveis se as CHAVES vieram (ausentes = fora do escopo). */
export function originVisibility(movement: MovementRecord): { room: boolean; person: boolean } {
  return {
    room: "origin_room_id" in movement || "origin_room" in movement,
    person: "previous_responsible_id" in movement || "previous_responsible" in movement,
  };
}

export function originOf(movement: MovementRecord) {
  return sideSummary(
    movement.origin_unit,
    movement.origin_room,
    movement.previous_responsible,
    originVisibility(movement),
  );
}

export function destinationOf(movement: MovementRecord) {
  return sideSummary(movement.destination_unit, movement.destination_room, movement.new_responsible);
}

export function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
