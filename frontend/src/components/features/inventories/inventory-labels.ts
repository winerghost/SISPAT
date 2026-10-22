// =============================================================================
// Rótulos, formatação e mensagens FIXAS da tela de Inventários.
// =============================================================================
// Nunca exibimos `error.message` vindo da API: cada status/código do contrato
// (docs/architecture/inventories-api.md) vira uma frase humana fixa. 404 não vaza
// detalhe (inventário/bem/local alheio, inexistente ou malformado = mesma resposta).
// O número patrimonial é TEXTO. Nada aqui calcula totais: o resumo vem do servidor.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { InventoryAction, InventoryItemResult, InventoryStatus } from "@/lib/inventories-api";
import { AAL2_MESSAGE, errorCode, formatDateTime } from "@/components/features/users/user-labels";
import { formatCalendarDate } from "@/components/features/assets/asset-labels";

export { formatCalendarDate, formatDateTime };

export const inventoriesQueryKey = ["inventories"] as const;
export const inventoryListKey = (params: unknown) => [...inventoriesQueryKey, "list", params] as const;
export const inventoryDetailKey = (id: string) => [...inventoriesQueryKey, "detail", id] as const;
export const inventorySummaryKey = (id: string) => [...inventoriesQueryKey, "summary", id] as const;
export const inventoryItemsKey = (id: string, params: unknown) => [...inventoriesQueryKey, "items", id, params] as const;

export const NAME_MAX = 200;
export const NOTES_MAX = 500;
export const REASON_MAX = 500;
export const SEARCH_MAX = 100;

export const STATUS_LABEL: Record<InventoryStatus, string> = {
  ABERTO: "Aberto",
  EM_ANDAMENTO: "Em andamento",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};

/** Filtros oferecidos (allowlist do backend). */
export const STATUS_OPTIONS: readonly InventoryStatus[] = ["ABERTO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"];

export const STATUS_HINT: Record<InventoryStatus, string> = {
  ABERTO: "Criado, ainda sem conferências. Um administrador precisa iniciá-lo.",
  EM_ANDAMENTO: "Aceita conferências de bens.",
  CONCLUIDO: "Encerrado de forma definitiva e imutável. Não aceita conferências.",
  CANCELADO: "Cancelado de forma definitiva e imutável. Não aceita conferências.",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as InventoryStatus] ?? "Estado desconhecido";
}

export const RESULT_LABEL: Record<InventoryItemResult, string> = {
  ENCONTRADO: "Encontrado",
  NAO_ENCONTRADO: "Não encontrado",
  DIVERGENTE: "Divergente",
};

export const RESULT_EXPLANATION: Record<InventoryItemResult, string> = {
  ENCONTRADO: "Bem localizado no local cadastrado (ou sem local informado).",
  NAO_ENCONTRADO: "Bem não localizado na conferência física.",
  DIVERGENTE: "Bem localizado em um local diferente do cadastrado.",
};

export function resultLabel(result: string): string {
  return RESULT_LABEL[result as InventoryItemResult] ?? "Resultado desconhecido";
}

/** Só estados ABERTO e EM_ANDAMENTO aceitam transição (UX; o backend decide). */
export function canStart(status: InventoryStatus | undefined): boolean {
  return status === "ABERTO";
}
export function canClose(status: InventoryStatus | undefined): boolean {
  return status === "EM_ANDAMENTO";
}
export function canCancel(status: InventoryStatus | undefined): boolean {
  return status === "ABERTO" || status === "EM_ANDAMENTO";
}
export function acceptsChecks(status: InventoryStatus | undefined): boolean {
  return status === "EM_ANDAMENTO";
}

export const INVENTORY_NOT_FOUND_MESSAGE = "Inventário não encontrado, ou fora do seu escopo de unidades.";

export const INVENTORY_STALE_MESSAGE =
  "Este inventário mudou desde que foi carregado (outra pessoa o iniciou, encerrou ou cancelou). Os dados foram recarregados.";

export const INVENTORY_LOOKUPS_ERROR_MESSAGE =
  "Não foi possível carregar as unidades para os filtros. A listagem continua disponível.";

export const RH_DENIED_MESSAGE =
  "Seu perfil (RH) não tem acesso aos inventários. A conferência patrimonial é restrita a administradores e usuários.";

export const NO_LOCATED_UPDATE_NOTE =
  "A conferência é apenas uma evidência registrada: ela NÃO altera o campo “Localizado” nem o local cadastrado do bem.";

export function isInventoryNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** 409 que significa "o estado do inventário mudou": recarregar e avisar. */
export function isStaleConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const code = errorCode(error);
  return code === "invalid_transition" || code === "inventory_closed" || code === "inventory_not_started";
}

export function isAlreadyChecked(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === "already_checked";
}

const CONFLICT_MESSAGES: Record<string, string> = {
  already_checked: "Este bem já foi conferido neste inventário. A conferência é única e imutável: não há reconferência.",
  inventory_not_started: "O inventário ainda não foi iniciado. Só inventários em andamento aceitam conferências.",
  inventory_closed: "O inventário está encerrado ou cancelado e não aceita conferências. Os dados foram recarregados.",
  invalid_transition:
    "Esta ação não é permitida no estado atual do inventário (ele pode ter sido iniciado, encerrado ou cancelado por outra pessoa). Os dados foram recarregados.",
  link_inactive: "O local observado está inativo. Escolha um local ativo da unidade do inventário.",
  unit_inactive: "A unidade está inativa. Escolha uma unidade ativa.",
  conflict: "Não foi possível registrar agora por conflito com outra operação. Recarregue e tente de novo.",
};

/** Mensagem humana para qualquer erro de escrita. `fallback` descreve a ação que falhou. */
export function inventoryErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para esta ação.";
  if (error.status === 404) return INVENTORY_NOT_FOUND_MESSAGE;
  if (error.status === 409) {
    return (code ? CONFLICT_MESSAGES[code] : undefined) ?? "A ação conflita com o estado atual. Recarregue e tente de novo.";
  }
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 400) return "Os dados enviados não foram aceitos. Revise os campos e tente novamente.";
  return fallback;
}

/** Mensagem da listagem/detalhe/itens (sem expor detalhe do backend). */
export function inventoryListErrorMessage(
  error: unknown,
  fallback = "Não foi possível carregar os inventários. Tente novamente.",
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (errorCode(error) === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para consultar os inventários.";
  if (error.status === 404) return "Nada foi encontrado no seu escopo de unidades.";
  if (error.status === 400) return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  if (error.status === 429) return rateLimitMessage(error);
  return fallback;
}

export interface TransitionCopy {
  title: string;
  confirm: string;
  pending: string;
  consequences: string[];
  success: string;
  failure: string;
}

export const TRANSITION_COPY: Record<InventoryAction, TransitionCopy> = {
  start: {
    title: "Iniciar inventário",
    confirm: "Iniciar inventário",
    pending: "Iniciando…",
    consequences: [
      "O inventário passa a EM ANDAMENTO e começa a aceitar a conferência dos bens da unidade.",
      "A transição é única: depois de iniciado, ele só pode ser encerrado ou cancelado.",
      "Os dados da campanha (nome, unidade e data de início) não podem ser editados.",
    ],
    success: "Inventário iniciado. Já aceita conferências.",
    failure: "Não foi possível iniciar o inventário agora. Tente novamente.",
  },
  close: {
    title: "Encerrar inventário",
    confirm: "Encerrar definitivamente",
    pending: "Encerrando…",
    consequences: [
      "O encerramento é DEFINITIVO: o inventário passa a CONCLUÍDO e fica IMUTÁVEL.",
      "Depois de encerrado, nenhuma conferência pode ser adicionada, alterada ou excluída, e ele não pode ser reaberto.",
      "Bens ainda não conferidos continuam como pendentes no resumo.",
      "A conferência não altera os bens (o campo “Localizado” e o local cadastrado permanecem como estão).",
      "A decisão e o autor ficam registrados na auditoria.",
    ],
    success: "Inventário encerrado. Ele agora é imutável.",
    failure: "Não foi possível encerrar o inventário agora. Tente novamente.",
  },
  cancel: {
    title: "Cancelar inventário",
    confirm: "Cancelar definitivamente",
    pending: "Cancelando…",
    consequences: [
      "O cancelamento é DEFINITIVO: o inventário passa a CANCELADO e fica IMUTÁVEL.",
      "Ele não pode ser reaberto nem receber novas conferências; as conferências já feitas permanecem registradas.",
      "Para conferir os bens de novo, será preciso criar outro inventário.",
      "A decisão e o autor ficam registrados na auditoria.",
    ],
    success: "Inventário cancelado. Ele agora é imutável.",
    failure: "Não foi possível cancelar o inventário agora. Tente novamente.",
  },
};

export function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
