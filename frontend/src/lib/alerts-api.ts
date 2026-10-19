// =============================================================================
// SISPAT-AGU — alerts-api.ts
// =============================================================================
// Contrato de `GET /api/v1/dashboard/alerts` (Etapa 4a — alertas patrimoniais
// determinísticos; funciona sem IA). Só transporte + validação por allowlist:
// qualquer resposta fora do formato é rejeitada (nada de renderizar o que não
// foi reconhecido). Textos são tratados como TEXTO PURO (o React escapa);
// números são exatamente os do backend.
// =============================================================================

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient } from "@/lib/api-client";

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface DashboardAlert {
  code: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  count: number;
}

export interface DashboardAlerts {
  generated_at: string;
  items: DashboardAlert[];
  /** Códigos de verificações que não puderam ser calculadas (resultado parcial). */
  unavailable: string[];
}

const CODE_PATTERN = /^[a-z0-9_.-]{1,64}$/i;
const MAX_ITEMS = 50;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === "string" && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

export function isDashboardAlert(value: unknown): value is DashboardAlert {
  if (!isRecord(value)) return false;
  return (
    isCode(value.code) &&
    isAlertSeverity(value.severity) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= MAX_TITLE &&
    typeof value.description === "string" &&
    value.description.length <= MAX_DESCRIPTION &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0
  );
}

/** Defesa em profundidade: só confia na resposta se couber na allowlist. */
export function isDashboardAlerts(value: unknown): value is DashboardAlerts {
  if (!isRecord(value)) return false;
  return (
    typeof value.generated_at === "string" &&
    value.generated_at.length > 0 &&
    value.generated_at.length <= 64 &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_ITEMS &&
    value.items.every(isDashboardAlert) &&
    Array.isArray(value.unavailable) &&
    value.unavailable.length <= MAX_ITEMS &&
    value.unavailable.every(isCode)
  );
}

/** `GET /api/v1/dashboard/alerts` — qualquer perfil autenticado, escopo no backend. */
export async function getDashboardAlerts(): Promise<DashboardAlerts> {
  const data = await apiClient.get<unknown>("/v1/dashboard/alerts");
  if (!isDashboardAlerts(data)) throw new Error("Resposta de alertas inválida.");
  return data;
}

export const DASHBOARD_ALERTS_QUERY_KEY = ["dashboard", "alerts"] as const;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

export function useDashboardAlerts(): UseQueryResult<DashboardAlerts, unknown> {
  return useQuery({
    queryKey: DASHBOARD_ALERTS_QUERY_KEY,
    queryFn: getDashboardAlerts,
    retry: shouldRetry,
    staleTime: 60_000,
  });
}
