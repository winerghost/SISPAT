// =============================================================================
// Rótulos e mensagens fixas da importação (cadastros de apoio e pendências de
// bens). Nunca exibimos `error.message` vindo da API: cada status/código vira
// uma frase humana fixa (403/404 genéricos, sem vazamento). Nada aqui escreve
// em console, storage ou URL.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { CatalogImportKind } from "@/lib/catalog-imports-api";
import { AAL2_MESSAGE, errorCode } from "@/components/features/users/user-labels";

export const CATALOG_KIND_LABEL: Record<CatalogImportKind, { tab: string; plural: string; singular: string }> = {
  units: { tab: "Unidades", plural: "unidades", singular: "unidade" },
  rooms: { tab: "Salas", plural: "salas", singular: "sala" },
  people: { tab: "Pessoas responsáveis", plural: "pessoas responsáveis", singular: "pessoa responsável" },
};

/** Rótulos dos códigos de pendência (cadastros e vínculos de bens). */
const PENDING_LABELS: Record<string, string> = {
  // Cadastros (catalog_import_service)
  unidade_ausente: "Coluna UNIDADE vazia",
  unidade_sem_alias: "Unidade sem alias (sigla não cadastrada)",
  unidade_inativa: "Unidade inativa",
  sigla_invalida: "Sigla vazia ou longa demais",
  orgao_invalido: "Órgão fora do formato esperado",
  nome_ausente: "Nome vazio",
  nome_invalido: "Nome inválido (tamanho ou caracteres)",
  marcador_ocioso: "Marcador “Ocioso” (não é pessoa)",
  email_invalido: "E-mail inválido",
  sigla_ligada_a_outra_unidade: "Sigla já ligada a outra unidade",
  sigla_repetida_com_outro_orgao: "Sigla repetida para outro órgão",
  // Bens (import_references)
  unidade_pertencente_nao_encontrada: "Unidade pertencente não encontrada",
  sala_nao_encontrada: "Sala não encontrada",
  sala_ambigua: "Sala ambígua (mais de uma correspondência)",
  pessoa_nao_encontrada: "Pessoa responsável não encontrada",
  pessoa_ambigua: "Pessoa responsável ambígua",
  usuario_pessoa_nao_encontrada: "Usuário (e-mail) sem pessoa correspondente",
  usuario_pessoa_ambigua: "Usuário (e-mail) com pessoa ambígua",
};

export function pendingLabel(code: string): string {
  return PENDING_LABELS[code] ?? `Pendência: ${code}`;
}

/** Normaliza `reasons`/`suspect` (lista ou texto único) em lista de textos. */
export function toTextList(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" && value ? [value] : [];
}

export const PREVIEW_GONE_MESSAGE =
  "Prévia não encontrada, expirada, já confirmada ou fora do seu escopo. Gere uma nova prévia.";

export type CatalogImportAction = "preview" | "items" | "confirm" | "pending";

/**
 * Mensagem fixa para qualquer erro da importação. 409 depende da ação: na
 * prévia é "aba não configurada"; na confirmação é "prévia expirada/já confirmada".
 */
export function catalogImportErrorMessage(error: unknown, action: CatalogImportAction): string {
  const fallback: Record<CatalogImportAction, string> = {
    preview: "Não foi possível gerar a prévia. Tente novamente.",
    items: "Não foi possível carregar os itens da prévia. Tente novamente.",
    confirm: "Não foi possível confirmar a importação. Nada foi alterado além do que consta no resultado. Tente novamente.",
    pending: "Não foi possível carregar o relatório de pendências. Tente novamente.",
  };
  if (!(error instanceof ApiError)) return fallback[action];
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === "aal2_required") return AAL2_MESSAGE;
  if (error.status === 403) return "Você não tem permissão para esta importação.";
  if (error.status === 404) {
    return action === "preview"
      ? "Cadastro não encontrado."
      : "Prévia não encontrada, expirada ou fora do seu escopo. Gere uma nova prévia.";
  }
  if (error.status === 409) {
    if (action === "preview") {
      return "A aba deste cadastro não está configurada para importação. Peça a quem administra o sistema para configurá-la.";
    }
    return "Esta prévia já foi confirmada, expirou ou não pode mais ser confirmada. Gere uma nova prévia.";
  }
  if (error.status === 422) {
    return "A planilha de origem não tem a estrutura esperada para este cadastro (colunas ausentes ou inválidas). Corrija a planilha e gere uma nova prévia.";
  }
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 502) {
    return "Não foi possível ler a planilha (Google Sheets) agora. Tente novamente em alguns instantes.";
  }
  if (error.status === 503) return "O serviço está temporariamente indisponível. Tente novamente em instantes.";
  if (error.status === 400) return "A solicitação não foi aceita. Revise a busca e os filtros e tente novamente.";
  return fallback[action];
}

/** A prévia deixou de existir/valer no servidor: a tela deve pedir uma nova. */
export function isPreviewGone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}
