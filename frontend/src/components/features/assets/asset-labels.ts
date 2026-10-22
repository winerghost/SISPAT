// =============================================================================
// Rótulos, formatação e mensagens FIXAS da tela de Patrimônios.
// =============================================================================
// Nunca exibimos `error.message` vindo da API: cada status/código do contrato
// (docs/architecture/assets-api.md) vira uma frase humana fixa. 404 não vaza
// detalhe (bem alheio, inexistente, malformado ou excluído = mesma resposta).
// O número patrimonial é TEXTO: nada aqui o converte em número.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { AssetRecord, LocatedStatus } from "@/lib/assets-api";
import { AAL2_MESSAGE, errorCode, formatDateTime } from "@/components/features/users/user-labels";

export { formatDateTime };

export const ASSET_SEARCH_MAX = 100;
export const PATRIMONY_MAX = 64;
export const TEXT_MAX = 2000;
export const REASON_MAX = 500;

export const LOCATED_LABEL: Record<LocatedStatus, string> = {
  SIM: "Localizado",
  NAO: "Não localizado",
  DESCONHECIDO: "Desconhecido",
};

export const LOCATED_OPTIONS: LocatedStatus[] = ["SIM", "NAO", "DESCONHECIDO"];

export const ASSET_VERSION_CONFLICT_MESSAGE =
  "Outra pessoa alterou este bem enquanto você editava. Os dados foram recarregados — revise e tente de novo.";

export const ASSET_NOT_FOUND_MESSAGE = "Bem não encontrado, ou fora do seu escopo de unidades.";

export const ASSET_LOOKUPS_ERROR_MESSAGE =
  "Não foi possível carregar as unidades, salas ou responsáveis para os filtros. A listagem continua disponível.";

export const BOND_STATUS_NONE_LABEL = "Sem vínculo";

export const BOND_STATUS_UNAVAILABLE_MESSAGE =
  "Não foi possível carregar as opções de vínculo; o filtro está indisponível. A listagem continua disponível.";

/** Rótulo da opção do filtro: "Ocioso (12)". A contagem é a do backend, sem cálculo local. */
export function bondStatusOptionLabel(option: { value: string; count: number }): string {
  return `${option.value} (${option.count.toLocaleString("pt-BR")})`;
}

/** Data de calendário AAAA-MM-DD → DD/MM/AAAA, sem conversão de fuso (não é instante). */
export function formatCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

export function isAssetVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === "version_conflict";
}

export function isAssetNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Mensagem humana para qualquer erro de escrita. `fallback` descreve a ação que falhou. */
export function assetErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para esta ação.";
  if (error.status === 404) return ASSET_NOT_FOUND_MESSAGE;
  if (error.status === 409) {
    if (code === "version_conflict") return ASSET_VERSION_CONFLICT_MESSAGE;
    if (code === "link_unit_mismatch") {
      return "A sala, o local ou o responsável escolhido pertence a outra unidade (ou a outra sala). Escolha vínculos da mesma unidade do bem.";
    }
    if (code === "link_inactive") {
      return "A sala, o local ou o responsável escolhido está inativo. Só é possível manter um vínculo inativo que o bem já tinha.";
    }
    if (code === "unit_inactive") {
      return "A unidade está inativa. Reative a unidade antes de cadastrar bens nela.";
    }
    return "Já existe um bem com este número patrimonial. Revise o número e tente de novo.";
  }
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 400) return "Os dados enviados não foram aceitos. Revise os campos e tente novamente.";
  return fallback;
}

/** Mensagem da listagem/detalhe (sem expor detalhe do backend). */
export function assetListErrorMessage(error: unknown): string {
  const fallback = "Não foi possível carregar os bens. Tente novamente.";
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (errorCode(error) === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para consultar os bens.";
  if (error.status === 404) return "Nada foi encontrado no seu escopo de unidades.";
  if (error.status === 400) return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  if (error.status === 429) return rateLimitMessage(error);
  return fallback;
}

export function assetHistoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "Você não tem permissão para ver o histórico deste bem.";
  }
  if (error instanceof ApiError && error.status === 404) return ASSET_NOT_FOUND_MESSAGE;
  return assetErrorMessage(error, "Não foi possível carregar o histórico. Tente novamente.");
}

// -----------------------------------------------------------------------------
// Histórico
// -----------------------------------------------------------------------------

export const OPERATION_LABEL: Record<string, string> = {
  ASSET_CREATED: "Bem cadastrado",
  ASSET_UPDATED: "Bem atualizado",
  ASSET_DELETED: "Bem excluído (lógico)",
  ASSET_RESTORED: "Bem restaurado",
};

export const FIELD_LABEL: Record<string, string> = {
  patrimony_number: "Número patrimonial",
  description: "Descrição",
  notes: "Observações",
  unit_id: "Unidade",
  owner_unit_id: "Unidade proprietária",
  responsible_person_id: "Responsável",
  room_id: "Sala",
  location_id: "Local",
  located: "Localizado",
  bond_status: "Vínculo",
  registration_date: "Data de registro",
  deleted_at: "Excluído em",
  version: "Versão",
};

/** Valor do histórico como TEXTO (React escapa; nunca HTML). `notes` nunca vem com valor. */
export function historyValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "string") {
    if (field === "located" && value in LOCATED_LABEL) return LOCATED_LABEL[value as LocatedStatus];
    if (field === "registration_date") return formatCalendarDate(value) ?? value;
    if (field.endsWith("_at")) return formatDateTime(value) ?? value;
    return value;
  }
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Uma linha por campo: "Campo: antes → depois" (antes/depois conforme existirem). */
export function describeHistory(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): string[] {
  const keys = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])];
  return keys.map((key) => {
    const label = FIELD_LABEL[key] ?? key;
    const hasPrev = !!previous && key in previous;
    const hasNext = !!next && key in next;
    if (key === "notes") return `${label}: alterado`; // conteúdo livre: nunca exibido no histórico
    if (hasPrev && hasNext) return `${label}: ${historyValue(key, previous![key])} → ${historyValue(key, next![key])}`;
    return `${label}: ${historyValue(key, hasNext ? next![key] : previous![key])}`;
  });
}

// -----------------------------------------------------------------------------
// Vistas do registro
// -----------------------------------------------------------------------------

export function unitRefText(unit: { code: string; name: string } | null | undefined): string {
  return unit ? `${unit.code} — ${unit.name}` : "—";
}

export function hasNotesKey(asset: AssetRecord): boolean {
  return "notes" in asset;
}

/** `true` se alguma linha trouxe a chave (listas vazias mostram todas as colunas). */
export function listHasKey(rows: readonly AssetRecord[], key: string): boolean {
  return rows.length === 0 || rows.some((row) => key in row);
}

/** Texto do formulário → valor do corpo (`null` limpa o opcional). */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
