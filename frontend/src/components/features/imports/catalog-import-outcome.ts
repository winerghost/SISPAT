// =============================================================================
// Estado derivado do resultado da confirmação de cadastros. Usa SÓ o que o
// backend confirmou (contadores e falhas). "Falha total" = nada salvo e há
// rejeições: nunca recebe tom de sucesso nem o texto "gravados".
// =============================================================================

import type { CatalogImportConfirmResponse } from "@/lib/catalog-imports-api";

export type CatalogOutcome = "success" | "partial" | "failure" | "nothing";

export function failureCount(result: CatalogImportConfirmResponse): number {
  return Math.max(result.falhas_total ?? 0, result.falhas?.length ?? 0);
}

export function savedCount(result: CatalogImportConfirmResponse): number {
  return result.created + result.updated;
}

export function deriveOutcome(result: CatalogImportConfirmResponse): CatalogOutcome {
  const failures = failureCount(result);
  const saved = savedCount(result);
  if (failures > 0 && saved === 0) return "failure";
  if (failures > 0) return "partial";
  if (saved === 0) return "nothing";
  return "success";
}

export const OUTCOME_TITLE: Record<CatalogOutcome, string> = {
  success: "Importação concluída.",
  partial: "Importação parcial: parte dos itens foi salva e parte foi rejeitada.",
  failure: "Nenhum item foi salvo: todos os itens enviados foram rejeitados.",
  nothing: "Nenhum registro foi salvo ou alterado nesta confirmação.",
};

/** Rótulos dos motivos de itens não gravados (além de `pendingLabel`). */
export const UNWRITTEN_REASON_LABEL: Record<string, string> = {
  duplicado_na_origem: "Duplicado na planilha (a 1ª ocorrência é mantida)",
  outro: "Outro motivo (veja a coluna de avisos na prévia)",
};

export const CLASSIFICATION_PT: Record<string, string> = {
  DUPLICADO: "Duplicados",
  INVALIDO: "Inválidos",
  CONFLITANTE: "Conflitantes",
};

export function summaryToast(result: CatalogImportConfirmResponse): string {
  const failures = failureCount(result);
  const counts =
    `${result.created} criado(s), ${result.updated} atualizado(s), ${result.inalterados} inalterado(s), ` +
    `${result.ignorados} ignorado(s)`;
  const outcome = deriveOutcome(result);
  if (outcome === "failure") return `Nenhum item foi salvo: ${failures} rejeitado(s). ${counts}.`;
  if (outcome === "partial") return `Importação parcial: ${counts}, ${failures} rejeitado(s).`;
  if (outcome === "nothing") return `Nenhum registro foi salvo ou alterado. ${counts}.`;
  return `Importação concluída: ${counts}.`;
}
