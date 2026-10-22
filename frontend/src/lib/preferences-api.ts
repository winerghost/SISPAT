// =============================================================================
// SISPAT-AGU — preferences-api.ts
// =============================================================================
// Tipos e chamadas de `/api/v1/me/preferences` (Etapa 3 — Aparência). Só
// transporte: valores permitidos, `version` e escopo (só o próprio usuário) são
// validados pelo backend Flask (`extra="forbid"`).
//
// Caminhos começam em `/v1/...` porque `NEXT_PUBLIC_API_URL` já inclui `/api`
// (ver `ai-settings-api.ts`). O Authorization é anexado pelo `apiClient`.
//
// Compatibilidade com backend ANTERIOR (sem as chaves novas): `dashboard_charts`
// sem location/bond/rooms e resposta sem `dashboard_layout` viram os padrões
// (sem erro). Chave PRESENTE com valor fora da allowlist = resposta inválida
// (defesa em profundidade: o painel usa os padrões e esconde os controles).
// =============================================================================

import { apiClient } from "@/lib/api-client";
import { isDensity, isFontScale, type Density, type FontScale } from "@/lib/ui-preferences";

// --- Tipo de gráfico de cada painel do dashboard (allowlist = contrato) -----

export const DASHBOARD_CHART_OPTIONS = {
  units: ["grouped", "stacked", "horizontal"],
  status: ["pie", "donut", "bar"],
  monthly: ["line", "area", "bar"],
  location: ["stacked", "grouped", "horizontal"],
  bond: ["pie", "donut", "bar"],
  rooms: ["bar", "horizontal"],
} as const;

export type DashboardChartPanel = keyof typeof DASHBOARD_CHART_OPTIONS;
export type DashboardChartType<P extends DashboardChartPanel = DashboardChartPanel> =
  (typeof DASHBOARD_CHART_OPTIONS)[P][number];

/** Todas as chaves SEMPRE resolvidas (o backend devolve o padrão quando não há escolha). */
export type DashboardChartsPrefs = { [P in DashboardChartPanel]: DashboardChartType<P> };

export const DEFAULT_DASHBOARD_CHARTS: DashboardChartsPrefs = {
  units: "grouped",
  status: "pie",
  monthly: "line",
  location: "stacked",
  bond: "donut",
  rooms: "horizontal",
};

/** Chaves do contrato original (obrigatórias na resposta). */
const REQUIRED_CHART_KEYS: readonly DashboardChartPanel[] = ["units", "status", "monthly"];
const CHART_KEYS = Object.keys(DASHBOARD_CHART_OPTIONS) as DashboardChartPanel[];

export function isDashboardChartType<P extends DashboardChartPanel>(
  panel: P,
  value: unknown,
): value is DashboardChartType<P> {
  return typeof value === "string" && (DASHBOARD_CHART_OPTIONS[panel] as readonly string[]).includes(value);
}

/** Chaves alteradas; `null` restaura o padrão daquele painel. */
export type DashboardChartsUpdate = { [P in DashboardChartPanel]?: DashboardChartType<P> | null };

// --- Painéis visíveis e ordem (dashboard_layout) ----------------------------

/** IDs dos painéis personalizáveis, na ordem PADRÃO (contrato do backend). */
export const DASHBOARD_PANEL_IDS = [
  "kpis",
  "units",
  "status",
  "monthly",
  "location",
  "bond",
  "pending",
  "rooms",
  "inventory",
  "tech_summary",
  "tech_category",
  "tech_units",
  "tech_status",
  "tech_no_owner",
  "tech_age",
] as const;

export type DashboardPanelId = (typeof DASHBOARD_PANEL_IDS)[number];

const LEGACY_PANEL_COUNT = 9;
const LEGACY_PANEL_IDS: readonly DashboardPanelId[] = DASHBOARD_PANEL_IDS.slice(0, LEGACY_PANEL_COUNT);

export interface DashboardLayout {
  /** Todos os IDs (15), na ordem efetiva. */
  order: DashboardPanelId[];
  /** IDs ocultos (nunca todos). */
  hidden: DashboardPanelId[];
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = Object.freeze({
  order: [...DASHBOARD_PANEL_IDS],
  hidden: [],
}) as DashboardLayout;

export function isDashboardPanelId(value: unknown): value is DashboardPanelId {
  return typeof value === "string" && (DASHBOARD_PANEL_IDS as readonly string[]).includes(value);
}

/** PATCH: `order`/`hidden` opcionais; `null` restaura o padrão. */
export type DashboardLayoutUpdate = { order?: DashboardPanelId[]; hidden?: DashboardPanelId[] } | null;

export function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
  const hiddenA = [...a.hidden].sort();
  const hiddenB = [...b.hidden].sort();
  return (
    a.order.length === b.order.length &&
    a.order.every((id, i) => id === b.order[i]) &&
    hiddenA.length === hiddenB.length &&
    hiddenA.every((id, i) => id === hiddenB[i])
  );
}

// --- Preferências -----------------------------------------------------------

export interface MyPreferences {
  density: Density;
  font_scale: FontScale;
  dashboard_charts: DashboardChartsPrefs;
  dashboard_layout: DashboardLayout;
  /** 0 = nunca gravada (padrões). Enviar de volta no PATCH. */
  version: number;
}

/** Corpo do PATCH: `version` obrigatório; só os campos alterados. */
export interface MyPreferencesUpdate {
  version: number;
  density?: Density;
  font_scale?: FontScale;
  dashboard_charts?: DashboardChartsUpdate;
  dashboard_layout?: DashboardLayoutUpdate;
}

function parseDashboardCharts(value: unknown): DashboardChartsPrefs | null {
  if (value === undefined) return { ...DEFAULT_DASHBOARD_CHARTS }; // backend ainda sem a chave
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const out = { ...DEFAULT_DASHBOARD_CHARTS } as Record<DashboardChartPanel, string>;
  for (const panel of CHART_KEYS) {
    const raw = candidate[panel];
    if (raw === undefined) {
      if (REQUIRED_CHART_KEYS.includes(panel)) return null;
      continue; // chave nova ausente (backend anterior): padrão
    }
    if (!isDashboardChartType(panel, raw)) return null;
    out[panel] = raw;
  }
  return out as DashboardChartsPrefs;
}

function parsePanelList(value: unknown): DashboardPanelId[] | null {
  if (!Array.isArray(value) || value.length > DASHBOARD_PANEL_IDS.length) return null;
  if (!value.every(isDashboardPanelId)) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}

function parseDashboardLayout(value: unknown): DashboardLayout | null {
  if (value === undefined || value === null) {
    return { order: [...DEFAULT_DASHBOARD_LAYOUT.order], hidden: [] }; // backend anterior
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const partial = parsePanelList(candidate.order);
  const hidden = parsePanelList(candidate.hidden ?? []);
  if (!partial || !hidden) return null;
  // Backend anterior devolve só os 9 painéis originais: os novos entram ao fim, na ordem
  // padrão. Qualquer outra ordem incompleta é resposta inválida.
  const legacy = partial.length === LEGACY_PANEL_COUNT && partial.every((id) => LEGACY_PANEL_IDS.includes(id));
  if (partial.length !== DASHBOARD_PANEL_IDS.length && !legacy) return null;
  const order = [...partial, ...DASHBOARD_PANEL_IDS.filter((id) => !partial.includes(id))];
  if (hidden.length >= DASHBOARD_PANEL_IDS.length) return null; // nunca todos ocultos
  return { order, hidden };
}

/** Defesa em profundidade: só confia na resposta se couber na allowlist. */
function parseMyPreferences(value: unknown): MyPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const charts = parseDashboardCharts(candidate.dashboard_charts);
  const layout = parseDashboardLayout(candidate.dashboard_layout);
  if (
    !charts ||
    !layout ||
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
    dashboard_layout: layout,
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
