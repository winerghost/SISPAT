// =============================================================================
// SISPAT-AGU — dashboard-export.ts
// =============================================================================
// Exportação CSV/XLSX da tabela AGREGADA de Tecnologia
// (`GET /api/v1/dashboard/tecnologia/export`). Fica fora de `dashboard-api.ts`
// porque grava um Blob como arquivo (mesmo padrão de `reports-api.ts`): a
// validação, o escopo, o limite de linhas e a auditoria são do BACKEND. O
// Bearer vai pelo api-client (nunca token em URL); o arquivo só é salvo se o
// Content-Type for o esperado. Nenhuma mensagem do backend é exibida.
// =============================================================================

import { ApiError, requestFile } from "@/lib/api-client";
import { NO_DASHBOARD_FILTERS, filterParams, type DashboardFilters } from "@/lib/dashboard-api";

export type TechExportFormat = "csv" | "xlsx";
const TECH_EXPORT_MIME: Record<TechExportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Nome local do arquivo (`sispat-tecnologia-AAAAMMDDTHHMMSSZ.<ext>`, UTC). */
export function techExportFileName(format: TechExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sispat-tecnologia-${stamp}.${format}`;
}

/**
 * Baixa a tabela agregada (Bearer via api-client; nada de token em URL) e a
 * entrega como arquivo. Só o formato e os filtros do dashboard saem na consulta.
 */
export async function downloadTechExport(
  format: TechExportFormat,
  filters: DashboardFilters = NO_DASHBOARD_FILTERS,
): Promise<string> {
  const searchParams = { ...filterParams(filters, undefined, "all"), format };
  const { blob, contentType } = await requestFile("/v1/dashboard/tecnologia/export", {
    searchParams,
    accept: `${TECH_EXPORT_MIME[format]}, application/json;q=0.5`,
  });
  // Defesa: um 200 que não seja o arquivo esperado (ex.: página de proxy) não é salvo.
  if (!contentType.startsWith(TECH_EXPORT_MIME[format])) throw new ApiError("Resposta inesperada.", 502);
  const fileName = techExportFileName(format);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}
