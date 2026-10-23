// =============================================================================
// Estado derivado do resultado da confirmação de cadastros. Usa SÓ o que o
// backend confirmou (contadores e falhas). "Falha total" = nada salvo e há
// rejeições: nunca recebe tom de sucesso nem o texto "gravados".
// =============================================================================

import type { CatalogImportConfirmResponse, CatalogImportJobStatus } from "@/lib/catalog-imports-api";
import type { ImportConfirmResponse } from "@/lib/imports-api";

export type CatalogOutcome = "success" | "partial" | "failure" | "nothing";

/**
 * Resultado de confirmação visto pela UI: cadastros (`CatalogImportConfirmResponse`)
 * e bens (`ImportConfirmResponse`, normalizado por `assetResultView`) usam o mesmo
 * contrato — `kind` só existe nos cadastros e `pendencias_vinculo`/`degraded` são opcionais.
 */
export type ConfirmResultView = Omit<CatalogImportConfirmResponse, "kind" | "preview_id"> & {
  kind?: CatalogImportConfirmResponse["kind"];
  preview_id?: string;
  /** Bens: pendências de vínculo dos bens criados (código → quantidade). */
  pendencias_vinculo?: Record<string, number>;
  /** O backend validou mal a resposta APÓS gravar: só os contadores são confiáveis. */
  degraded?: boolean;
};

type OutcomeInput = Pick<ConfirmResultView, "created" | "updated"> &
  Partial<Pick<ConfirmResultView, "status" | "falhas_total" | "falhas">>;

export function failureCount(result: OutcomeInput): number {
  return Math.max(result.falhas_total ?? 0, result.falhas?.length ?? 0);
}

export function savedCount(result: OutcomeInput): number {
  return result.created + result.updated;
}

const JOB_STATUSES: readonly CatalogImportJobStatus[] = ["CONCLUIDO", "PARCIAL", "FALHOU"];

/**
 * Estado derivado do resultado. O `status` do job (backend) tem precedência
 * sobre a contagem: FALHOU nunca vira "nothing" neutro nem verde; PARCIAL nunca
 * é verde; um status desconhecido também não é verde. Só CONCLUIDO (ou ausente,
 * backends antigos) cai na contagem de salvos/rejeitados.
 */
export function deriveOutcome(result: OutcomeInput): CatalogOutcome {
  const failures = failureCount(result);
  const saved = savedCount(result);
  const status = result.status as string | undefined;
  if (status === "FALHOU") return "failure";
  if (status === "PARCIAL") return saved === 0 ? "failure" : "partial";
  if (status !== undefined && !JOB_STATUSES.includes(status as CatalogImportJobStatus)) {
    return saved === 0 ? "failure" : "partial";
  }
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
  patrimonio_conflitante: "Número patrimonial com mais de um bem ativo (conflito)",
  dados_invalidos: "Dados inválidos na linha (veja os avisos na prévia)",
  outro: "Outro motivo (veja a coluna de avisos na prévia)",
};

export const CLASSIFICATION_PT: Record<string, string> = {
  DUPLICADO: "Duplicados",
  INVALIDO: "Inválidos",
  CONFLITANTE: "Conflitantes",
};

export function summaryToast(result: ConfirmResultView): string {
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

/**
 * Resultado de BENS no formato comum da UI: a falha ganha o rótulo
 * "Patrimônio <número>" (texto, preserva zeros) e `kind` fica ausente.
 */
export function assetResultView(result: ImportConfirmResponse): ConfirmResultView {
  return {
    ...result,
    falhas: (result.falhas ?? []).map((failure) => ({
      item_id: failure.item_id,
      row: failure.row,
      label: failure.patrimony_number ? `Patrimônio ${failure.patrimony_number}` : null,
      reason: failure.reason,
    })),
  };
}
