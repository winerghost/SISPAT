// =============================================================================
// SISPAT-AGU — preferences-api.ts
// =============================================================================
// Tipos e chamadas de `/api/v1/me/preferences` (Etapa 3 — Aparência). Só
// transporte: valores permitidos, `version` e escopo (só o próprio usuário) são
// validados pelo backend Flask (`extra="forbid"`).
//
// Caminhos começam em `/v1/...` porque `NEXT_PUBLIC_API_URL` já inclui `/api`
// (ver `ai-settings-api.ts`). O Authorization é anexado pelo `apiClient`.
// =============================================================================

import { apiClient } from "@/lib/api-client";
import { isDensity, isFontScale, type Density, type FontScale } from "@/lib/ui-preferences";

// --- Tipo de gráfico de cada painel do dashboard (allowlist = contrato) -----

export const DASHBOARD_CHART_OPTIONS = {
  units: ["grouped", "stacked", "horizontal"],
  status: ["pie", "donut", "bar"],
  monthly: ["line", "area", "bar"],
} as const;

export type DashboardChartPanel = keyof typeof DASHBOARD_CHART_OPTIONS;
export type DashboardChartType<P extends DashboardChartPanel = DashboardChartPanel> =
  (typeof DASHBOARD_CHART_OPTIONS)[P][number];

/** As 3 chaves SEMPRE resolvidas (o backend devolve o padrão quando não há escolha). */
export type DashboardChartsPrefs = { [P in DashboardChartPanel]: DashboardChartType<P> };

export const DEFAULT_DASHBOARD_CHARTS: DashboardChartsPrefs = {
  units: "grouped",
  status: "pie",
  monthly: "line",
};

export function isDashboardChartType<P extends DashboardChartPanel>(
  panel: P,
  value: unknown,
): value is DashboardChartType<P> {
  return typeof value === "string" && (DASHBOARD_CHART_OPTIONS[panel] as readonly string[]).includes(value);
}

/** Chaves alteradas; `null` restaura o padrão daquele painel. */
export type DashboardChartsUpdate = { [P in DashboardChartPanel]?: DashboardChartType<P> | null };

export interface MyPreferences {
  density: Density;
  font_scale: FontScale;
  dashboard_charts: DashboardChartsPrefs;
  /** 0 = nunca gravada (padrões). Enviar de volta no PATCH. */
  version: number;
}

/** Corpo do PATCH: `version` obrigatório; só os campos alterados. */
export interface MyPreferencesUpdate {
  version: number;
  density?: Density;
  font_scale?: FontScale;
  dashboard_charts?: DashboardChartsUpdate;
}

function parseDashboardCharts(value: unknown): DashboardChartsPrefs | null {
  if (value === undefined) return { ...DEFAULT_DASHBOARD_CHARTS }; // backend ainda sem a chave
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    isDashboardChartType("units", candidate.units) &&
    isDashboardChartType("status", candidate.status) &&
    isDashboardChartType("monthly", candidate.monthly)
  ) {
    return { units: candidate.units, status: candidate.status, monthly: candidate.monthly };
  }
  return null;
}

/** Defesa em profundidade: só confia na resposta se couber na allowlist. */
function parseMyPreferences(value: unknown): MyPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const charts = parseDashboardCharts(candidate.dashboard_charts);
  if (
    !charts ||
    !isDensity(candidate.density) ||
    !isFontScale(candidate.font_scale) ||
    typeof candidate.version !== "number" ||
    !Number.isSafeInteger(candidate.version)
  ) {
    return null;
  }
  return {
    density: candidate.density,
    font_scale: candidate.font_scale,
    dashboard_charts: charts,
    version: candidate.version,
  };
}

export function isMyPreferences(value: unknown): value is MyPreferences {
  return parseMyPreferences(value) !== null;
}

/** `GET /api/v1/me/preferences` — qualquer perfil autenticado, só o próprio. */
export async function getMyPreferences(): Promise<MyPreferences> {
  const data = parseMyPreferences(await apiClient.get<unknown>("/v1/me/preferences"));
  if (!data) throw new Error("Resposta de preferências inválida.");
  return data;
}

/** `PATCH /api/v1/me/preferences` — 409 em conflito de versão. */
export async function updateMyPreferences(payload: MyPreferencesUpdate): Promise<MyPreferences> {
  const data = parseMyPreferences(await apiClient.patch<unknown>("/v1/me/preferences", payload));
  if (!data) throw new Error("Resposta de preferências inválida.");
  return data;
}
