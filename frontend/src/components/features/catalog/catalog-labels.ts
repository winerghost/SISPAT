// =============================================================================
// Rótulos, máscaras e mensagens de erro dos cadastros de apoio.
// =============================================================================
// Nunca exibimos `error.message` vindo da API: cada status/código do contrato
// (docs/architecture/cadastros-apoio-api.md) vira uma frase humana fixa. 403 e
// 404 não vazam detalhe (alvo alheio, inexistente ou malformado = mesmo 404).
// Telefone é dado pessoal (LGPD): só máscara na exibição; nada disto escreve em
// console, storage ou URL.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import { AAL2_MESSAGE, errorCode } from "@/components/features/users/user-labels";

export { formatDateTime } from "@/components/features/users/user-labels";

export type ActiveFilter = "all" | "true" | "false";

export const SEARCH_MAX = 100;
export const SEARCH_DEBOUNCE_MS = 300;

export type CatalogNoun = "sala" | "pessoa responsável" | "unidade";

export const VERSION_CONFLICT_MESSAGE =
  "Outra pessoa alterou este registro enquanto você editava. Os dados foram recarregados — revise e tente de novo.";

export const INACTIVE_UNIT_MESSAGE =
  "A unidade está inativa. Reative a unidade antes de criar ou reativar registros nela.";

export function isCatalogVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === "version_conflict";
}

export function isCatalogNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

const DUPLICATE: Record<CatalogNoun, string> = {
  sala: "Já existe uma sala com estes dados nesta unidade. Revise o nome e tente de novo.",
  "pessoa responsável":
    "Já existe uma pessoa responsável com estes dados (e-mail ou identificador institucional). Revise e tente de novo.",
  unidade: "Já existe um registro com estes dados. Revise e tente de novo.",
};

/**
 * Mensagem humana para qualquer erro dos cadastros. `fallback` descreve a ação
 * que falhou ("Não foi possível …").
 */
export function catalogErrorMessage(error: unknown, noun: CatalogNoun, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para esta ação.";
  if (error.status === 404) return "Registro não encontrado, ou fora do seu escopo de unidades.";
  if (error.status === 409) {
    if (code === "version_conflict") return VERSION_CONFLICT_MESSAGE;
    if (code === "unit_inactive") return INACTIVE_UNIT_MESSAGE;
    return DUPLICATE[noun];
  }
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 400) return "Os dados enviados não foram aceitos. Revise os campos e tente novamente.";
  return fallback;
}

/** Mensagem da listagem (sem expor detalhe do backend). */
export function catalogListErrorMessage(error: unknown, noun: CatalogNoun): string {
  if (error instanceof ApiError && error.status === 400) {
    return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  }
  return catalogErrorMessage(error, noun, `Não foi possível carregar ${PLURAL[noun]}. Tente novamente.`);
}

const PLURAL: Record<CatalogNoun, string> = {
  sala: "as salas",
  "pessoa responsável": "as pessoas responsáveis",
  unidade: "as unidades",
};

export const DENIED_MESSAGE =
  "Você não tem permissão para administrar este cadastro. É necessário o papel ADM com a verificação em duas etapas concluída.";

// -----------------------------------------------------------------------------
// Telefone
// -----------------------------------------------------------------------------

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Exibição mascarada: só os 4 últimos dígitos (ex.: `(••) •••••-4567`). */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = digitsOf(phone);
  if (digits.length < 4) return "(••) •••••-••••";
  return `(••) •••••-${digits.slice(-4)}`;
}

/** Formato de edição (só para o ADM que edita): `(63) 99123-4567`. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = digitsOf(phone);
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

/** Comparação independente de máscara (para detectar alteração no formulário). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  return digitsOf(a ?? "") === digitsOf(b ?? "");
}

/** Texto do formulário → valor do corpo (`null` limpa o opcional). */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
