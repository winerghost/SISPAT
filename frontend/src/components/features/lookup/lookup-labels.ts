// =============================================================================
// Mensagens FIXAS das telas de consulta (unidades, salas, responsáveis).
// Nunca exibimos `error.message` do backend. 403/404 não vazam detalhe: alvo
// alheio, inexistente ou fora do escopo de unidades responde igual.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import { AAL2_MESSAGE, errorCode } from "@/components/features/users/user-labels";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import type { AccessibleUnit } from "@/lib/catalog-api";

export type LookupPlural = "as unidades" | "as salas" | "as pessoas responsáveis";

export function lookupErrorMessage(error: unknown, plural: LookupPlural): string {
  const fallback = `Não foi possível carregar ${plural}. Tente novamente.`;
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (errorCode(error) === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return `Você não tem permissão para consultar ${plural}.`;
  if (error.status === 404) return "Nada foi encontrado no seu escopo de unidades.";
  if (error.status === 400) return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  if (error.status === 429) return rateLimitMessage(error);
  return fallback;
}

export const SESSION_ERROR_MESSAGE = "Não foi possível confirmar sua sessão. Entre novamente.";

export const UNITS_FILTER_ERROR_MESSAGE =
  "Não foi possível carregar a lista de unidades para o filtro. A listagem continua disponível.";

/** Unidade da linha: "SIGLA — Nome" quando conhecida; "—" enquanto a lista não chegou. */
export function lookupUnitText(unitId: string | undefined, units: AccessibleUnit[] | undefined): string {
  if (!unitId || !units) return "—";
  const unit = units.find((candidate) => candidate.id === unitId);
  return unit ? unitLabel(unit) : "Unidade fora da lista";
}

/** `true` se alguma linha trouxe a chave (listas vazias mostram todas as colunas). */
export function hasKey<T extends object>(rows: readonly T[], key: string): boolean {
  return rows.length === 0 || rows.some((row) => key in row);
}

/** Texto sem acento e em minúsculas, para a busca local na lista de unidades. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
