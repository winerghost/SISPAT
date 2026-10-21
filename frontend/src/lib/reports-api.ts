// =============================================================================
// SISPAT-AGU — reports-api.ts
// =============================================================================
// Transporte + helpers PUROS da tela de Relatórios (`GET /api/v1/reports` e
// `GET /api/v1/reports/<kind>/export`). Só montagem de parâmetros por allowlist
// (a do catálogo devolvido pelo backend) e mensagens de UX: a validação, o
// escopo de unidade, o limite de linhas e a auditoria são do BACKEND. O arquivo
// é baixado com fetch autenticado (Bearer, nunca token em URL/storage) -> Blob
// -> link temporário; o nome é montado aqui (Content-Disposition não é exposto
// por CORS). Nenhuma mensagem do backend é exibida.
// =============================================================================

import { ApiError, apiClient, requestFile } from "@/lib/api-client";
import { formatRetryAfter } from "@/lib/api-errors";

export type ReportFormat = "csv" | "xlsx";
export type ReportFilterType = "text" | "enum" | "uuid" | "unit" | "inventory" | "date";

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportFilterDef {
  name: string;
  type: ReportFilterType;
  options?: string[];
  max_length?: number;
}

export interface ReportDef {
  id: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  filters: ReportFilterDef[];
  sorts: string[];
  default_sort: string;
  include_deleted_allowed: boolean;
  formats?: ReportFormat[];
}

export interface ReportCatalog {
  generated_at?: string;
  max_rows: number;
  formats: ReportFormat[];
  reports: ReportDef[];
}

export interface ReportFormState {
  format: ReportFormat;
  sort: string;
  includeDeleted: boolean;
  filters: Record<string, string>;
}

export const REPORT_FORMATS: readonly ReportFormat[] = ["csv", "xlsx"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KIND_RE = /^[a-z][a-z-]{0,40}$/;

const MIME: Record<ReportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function getReportCatalog(): Promise<ReportCatalog> {
  return apiClient.get<ReportCatalog>("/v1/reports");
}

export function initialReportForm(def: ReportDef): ReportFormState {
  return { format: "csv", sort: def.default_sort, includeDeleted: false, filters: {} };
}

/** Pares ordenados que um filtro de intervalo forma (`*_from` / `*_to`). */
const RANGE_PAIRS: readonly [string, string][] = [
  ["created_from", "created_to"],
  ["checked_from", "checked_to"],
];

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && parsed.getUTCFullYear() >= 1900;
}

/** Validação de UX por filtro (o backend revalida tudo). `undefined` = ok. */
export function validateReportFilters(def: ReportDef, filters: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const filter of def.filters) {
    const value = (filters[filter.name] ?? "").trim();
    if (!value) continue;
    if (filter.type === "date" && !isValidIsoDate(value)) errors[filter.name] = "Informe uma data válida.";
    if (filter.type === "uuid" && !UUID_RE.test(value)) errors[filter.name] = "Informe um identificador (UUID) válido.";
    if (filter.type === "enum" && !(filter.options ?? []).includes(value)) errors[filter.name] = "Escolha uma das opções.";
    if ((filter.type === "text" || filter.type === "uuid") && filter.max_length && value.length > filter.max_length) {
      errors[filter.name] = `Use no máximo ${filter.max_length} caracteres.`;
    }
  }
  for (const [from, to] of RANGE_PAIRS) {
    const a = (filters[from] ?? "").trim();
    const b = (filters[to] ?? "").trim();
    if (a && b && !errors[from] && !errors[to] && a > b && def.filters.some((f) => f.name === to)) {
      errors[to] = "A data final não pode ser anterior à inicial.";
    }
  }
  return errors;
}

/**
 * Query da exportação: SÓ filtros declarados no catálogo, valores não vazios,
 * `sort` dentro da allowlist e `include_deleted` apenas se permitido.
 */
export function buildExportParams(def: ReportDef, form: ReportFormState): Record<string, string> {
  const params: Record<string, string> = { format: REPORT_FORMATS.includes(form.format) ? form.format : "csv" };
  if (def.sorts.includes(form.sort)) params.sort = form.sort;
  for (const filter of def.filters) {
    const value = (form.filters[filter.name] ?? "").trim().replace(/\s+/g, " ");
    if (value) params[filter.name] = value;
  }
  if (def.include_deleted_allowed && form.includeDeleted) params.include_deleted = "true";
  return params;
}

/** `sispat-<kind>-AAAAMMDDTHHMMSSZ.<ext>` (UTC), como o backend. */
export function reportFileName(kind: string, format: ReportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sispat-${kind}-${stamp}.${format}`;
}

/** Quantidade de registros (sem o cabeçalho) de um CSV; aspas duplas respeitadas. */
export function countCsvRows(text: string): number {
  let inQuotes = false;
  let records = 0;
  let pending = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      pending = true;
    } else if (ch === "\n" && !inQuotes) {
      records += 1;
      pending = false;
    } else if (ch !== "\r" && ch !== "﻿") {
      pending = true;
    }
  }
  if (pending) records += 1;
  return Math.max(0, records - 1);
}

export interface ReportDownload {
  fileName: string;
  /** Linhas de dados; `null` quando não dá para saber (XLSX). */
  rows: number | null;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Dá tempo ao navegador de iniciar o download antes de liberar o link temporário.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const MAX_COUNT_BYTES = 25 * 1024 * 1024;

/** Baixa a exportação (Bearer via api-client) e dispara o salvamento do arquivo. */
export async function downloadReport(def: ReportDef, form: ReportFormState): Promise<ReportDownload> {
  if (!KIND_RE.test(def.id)) throw new ApiError("Relatório inválido.", 404);
  const params = buildExportParams(def, form);
  const format = params.format as ReportFormat;
  const { blob, contentType } = await requestFile(`/v1/reports/${encodeURIComponent(def.id)}/export`, {
    searchParams: params,
    accept: `${MIME[format]}, application/json;q=0.5`,
  });
  // Defesa: um 200 que não seja o arquivo esperado (ex.: página de proxy) não é salvo.
  if (!contentType.startsWith(MIME[format])) throw new ApiError("Resposta inesperada.", 502);
  const fileName = reportFileName(def.id, format);
  let rows: number | null = null;
  if (format === "csv" && blob.size <= MAX_COUNT_BYTES) {
    try {
      rows = countCsvRows(await blob.text());
    } catch {
      rows = null;
    }
  }
  triggerDownload(blob, fileName);
  return { fileName, rows };
}

/** Texto fixo por status/código — nunca a mensagem vinda do backend. */
export function reportErrorMessage(error: unknown, maxRows?: number): string {
  if (!(error instanceof ApiError)) return "Não foi possível gerar o arquivo. Tente novamente.";
  if (error.status === 413 || error.code === "row_limit_exceeded") {
    const limit = maxRows ? ` de ${maxRows.toLocaleString("pt-BR")} linhas` : "";
    return `O relatório ultrapassa o limite${limit} por arquivo. Refine os filtros (unidade, período, situação) e tente novamente.`;
  }
  if (error.status === 429) {
    return `Muitas exportações em pouco tempo. Aguarde ${formatRetryAfter(error.retryAfterSeconds)} e tente de novo.`;
  }
  if (error.status === 403) {
    return error.code === "AAL2_REQUIRED"
      ? "Conclua a verificação em duas etapas (MFA) para exportar este relatório."
      : "Você não tem permissão para exportar este relatório.";
  }
  if (error.status === 404) return "Relatório, unidade ou inventário não encontrado no seu escopo. Revise os filtros.";
  if (error.status === 400) return "Os filtros não foram aceitos. Revise os valores e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para exportar.";
  if (error.status === 0) return "Falha de rede ao gerar o arquivo. Verifique sua conexão e tente novamente.";
  return "Não foi possível gerar o arquivo. Tente novamente.";
}
