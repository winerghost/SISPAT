import type { Page, Request, Route } from "@playwright/test";

import { defaultAdminAccess, type AdminAccessMock } from "./admin-access-mocks";
import { auditDetailReply, auditListReply, defaultAuditLogs, type AuditDetailMock } from "./audit-mocks";
import { defaultUnitAccess, queryUnitAccess, type UnitAccessItemMock } from "./unit-access-mocks";
import { mockPage, mockPageSize } from "./page-size";
import { defaultReportsState, handleReports, type ReportsMockState } from "./reports-mocks";
import {
  defaultDashboard,
  handleDashboard,
  type DashboardEndpoint,
  type DashboardMockData,
} from "./dashboard-mocks";
import { defaultAssets, handleAssets, type AssetMockState } from "./asset-mocks";
import { defaultMovements, handleMovements, type MovementMockState } from "./movement-mocks";
import { defaultInventories, handleInventories, type InventoryMockState } from "./inventory-mocks";
import { defaultCatalog, handleCatalog, type CatalogMockState } from "./catalog-mocks";
import {
  defaultCatalogImport,
  handleCatalogImports,
  PENDING_COUNTS_MOCK,
  type CatalogImportMockOptions,
  type CatalogImportMockState,
} from "./catalog-import-mocks";

// =============================================================================
// Mocks SINTÉTICOS do Supabase Auth e da API Flask para os testes e2e.
// =============================================================================
// Nenhum dado aqui é real: e-mails usam o TLD reservado `.invalid`, UUIDs são
// fixos e artificiais, tokens são JWTs falsos sem assinatura válida.
// Qualquer requisição para fora de localhost (inclusive para o Supabase/VPS
// reais) é ABORTADA — ver `installMocks`.
// =============================================================================

/** token_hash sintético aceito pelo mock de /auth/v1/verify (qualquer outro => otp_expired). */
export const VALID_INVITE_TOKEN_HASH = "hash-valido-e2e";
export const SUPABASE_URL = "http://127.0.0.1:54321";
export const API_URL = "http://127.0.0.1:5000/api";
/**
 * Chaves de storage da sessão: `sispat-auth` em sessionStorage (cliente atual,
 * ver src/lib/supabase-client.ts) e a chave padrão do supabase-js em
 * localStorage (versões anteriores). Semeamos as duas para não acoplar os
 * testes a esse detalhe de implementação.
 */
export const SESSION_STORAGE_KEY = "sispat-auth";
export const LEGACY_STORAGE_KEY = "sb-127-auth-token";

/** Marcador XSS inofensivo: se executar, define `window.__xss`. */
export const XSS_IMG = `<img src=x onerror="window.__xss=1">`;
export const XSS_SCRIPT = `<script>window.__xss=2</script>`;

export type Role = "ADM" | "USER" | "RH";

export interface MockOptions {
  /** Perfil devolvido por `GET /api/v1/me`. */
  role?: Role;
  /** AAL inicial informado por `/me` (o verify do MFA o promove para aal2). */
  aal?: "aal1" | "aal2";
  /** Se o usuário tem fator TOTP verificado (Supabase `user.factors`). */
  hasVerifiedFactor?: boolean;
  /** Fator TOTP NÃO verificado deixado por uma tentativa anterior de cadastro. */
  hasStaleUnverifiedFactor?: boolean;
  /** Valor de `totp.qr_code` devolvido pelo `mfa.enroll` (padrão: SVG cru válido). */
  enrollQrCode?: string;
  /** Perfis/permissões de `GET /api/v1/admin/{roles,permissions}` (padrão: ADM 40, USER 11, RH 6). */
  adminAccess?: AdminAccessMock;
  /** Status HTTP forçado em `GET /api/v1/admin/{roles,permissions}` (ex.: 500, 403). */
  adminAccessStatus?: number;
  /** Atraso (ms) das respostas de `/admin/{roles,permissions}` — testa o estado "carregando". */
  adminAccessDelayMs?: number;
  /** Registros de `GET /api/v1/admin/audit-logs[/<id>]` (padrão: 30 sintéticos). */
  auditLogs?: AuditDetailMock[];
  /** Status HTTP forçado em `/admin/audit-logs` (lista); ex.: 500, 403, 429. */
  auditStatus?: number;
  /** Status HTTP forçado no detalhe `/admin/audit-logs/<id>`. */
  auditDetailStatus?: number;
  /** Atraso (ms) das respostas de `/admin/audit-logs` — testa o estado "carregando". */
  auditDelayMs?: number;
  /** Vínculos de `GET /api/v1/admin/unit-access` (padrão: 30 usuários sintéticos). */
  unitAccess?: UnitAccessItemMock[];
  /** Status HTTP forçado em `GET /api/v1/admin/unit-access` (ex.: 500, 403); testes podem mutar `state.unitAccessStatus`. */
  unitAccessStatus?: number;
  /** Atraso (ms) de `/admin/unit-access` — testa o estado "carregando". */
  unitAccessDelayMs?: number;
  /** Comportamento de `GET /api/v1/reports` e da exportação (status forçados, atraso, linhas). */
  reports?: Partial<ReportsMockState>;
  /** Sobrescreve o estado inicial de `GET /api/v1/settings/ai`. */
  ai?: Partial<AiSettingsMock>;
  /**
   * Sobrescreve o estado inicial de `GET /api/v1/me/preferences` (Aparência).
   * `dashboard_charts` é parcial (as chaves ausentes ficam no padrão).
   */
  prefs?: PreferencesMockInput;
  /**
   * Simula o backend ANTERIOR: o GET omite `dashboard_layout` e as chaves
   * location/bond/rooms de `dashboard_charts` (o PATCH segue o contrato novo).
   */
  prefsLegacy?: boolean;
  /** Status HTTP forçado em `GET /api/v1/me/preferences` (ex.: 500 testa o estado de erro). */
  prefsGetStatus?: number;
  /** Resposta de `GET /api/v1/dashboard/alerts` (padrão: 3 alertas, um crítico). */
  alerts?: AlertsMock;
  /** Status HTTP forçado em `GET /api/v1/dashboard/alerts` (ex.: 500 testa o estado de erro). */
  alertsStatus?: number;
  /** Respostas de `GET /api/v1/dashboard/*` (resumo, por-unidade, ..., inventario, tipos; padrão: dados sintéticos). */
  dashboard?: Partial<DashboardMockData>;
  /** Status HTTP forçado por endpoint do dashboard (ex.: `{ "por-unidade": 500 }`); testes podem mutar `state.dashboardStatus`. */
  dashboardStatus?: Partial<Record<DashboardEndpoint, number>>;
  /** Resposta de `GET /api/v1/ai/insights` (padrão: status ok com os 3 tipos). */
  aiInsights?: AiInsightsMock;
  /** Status HTTP forçado em `GET /api/v1/ai/insights` (ex.: 500, 403). */
  aiInsightsStatus?: number;
  /** Resposta de `POST /api/v1/ai/ask` (padrão: status ok com resposta). */
  aiAsk?: AiAskMock;
  /** Status HTTP forçado em `POST /api/v1/ai/ask` (ex.: 429, 403, 500). */
  aiAskStatus?: number;
  /** Atraso (ms) da resposta de `POST /api/v1/ai/ask` — testa envio duplo/estado "enviando". */
  aiAskDelayMs?: number;
  /** Resultado de `POST /users/<id>/password-reset` (padrão "sent"). */
  passwordReset?: "sent" | "unavailable";
  /** Supabase Storage fora do ar: rotas de foto → 503 `storage_unavailable`. */
  storageUnavailable?: boolean;
  /** Se o próprio usuário já tem foto (`/me/avatar-url`). */
  meHasAvatar?: boolean;
  /** Status HTTP forçado em `GET /api/v1/me` (ex.: 401 = usuário inativo/sem registro local). */
  meStatus?: number;
  /** `GET /api/v1/users` responde 429 com este `Retry-After` (segundos; 0 = sem o cabeçalho). */
  usersRateLimitRetryAfter?: number;
  /** Status de `POST /security/mfa/factor-added-notice` (padrão 204; ex.: 500 testa o best-effort). */
  factorNoticeStatus?: number;
  /** Cadastros de apoio: omite a chave `phone` (como o backend faz para quem não é ADM). */
  catalogHidePhone?: boolean;
  /** Cadastros de apoio: omite a chave `address` das unidades. */
  catalogHideAddress?: boolean;
  /** Importação dos cadastros (/catalog-imports) e pendências de bens: erros/variações simuladas. */
  catalogImport?: CatalogImportMockOptions;
  /** `GET /v1/units/accessible` responde com este status de erro (ex.: 403, 404, 500). */
  accessibleUnitsStatus?: number;
  /** `GET /v1/rooms` e `GET /v1/responsible-people` respondem com este status de erro (telas de consulta). */
  lookupListStatus?: number;
  /** `GET /v1/assets` responde com este status de erro (ex.: 403, 404, 500); testes também podem mudar `state.forceListStatus`. */
  assetsListStatus?: number;
  /** `GET /v1/assets/bond-statuses` responde com este status de erro (filtro "Vínculo" indisponível). */
  assetBondStatusesStatus?: number;
  /** `GET /v1/movements` responde com este status de erro (ex.: 403, 404, 500); testes também podem mudar `state.forceMovementListStatus`. */
  movementsListStatus?: number;
  /** `GET /v1/inventories` responde com este status de erro (ex.: 403, 404, 500); testes também podem mudar `state.forceInventoryListStatus`. */
  inventoriesListStatus?: number;
}

/** Espelho sintético do contrato `/api/v1/settings/ai` (docs/architecture/modulo-configuracoes.md). */
export interface AiSettingsMock {
  status: "active" | "disabled" | "unavailable";
  env_enabled: boolean;
  enabled: boolean;
  provider: "none" | "openai" | "anthropic" | "deepseek";
  model: string | null;
  features: Record<"alerts_explain" | "executive_summary" | "assistant" | "data_quality", boolean>;
  monthly_token_cap: number;
  deepseek_acknowledged: boolean;
  keys: Record<"openai" | "anthropic" | "deepseek", "configured" | "not_configured">;
  models: Record<"openai" | "anthropic" | "deepseek", string[]>;
  version: number;
  updated_at: string;
}

/** Espelho sintético do contrato `/api/v1/dashboard/alerts` (Etapa 4a). */
export interface AlertsMock {
  generated_at: string;
  items: {
    code: string;
    severity: "info" | "warning" | "critical";
    title: string;
    description: string;
    count: number;
  }[];
  unavailable: string[];
}

export function defaultAlerts(): AlertsMock {
  return {
    generated_at: "2026-10-15T15:00:00Z",
    items: [
      {
        code: "duplicate_asset_number",
        severity: "critical",
        title: "Patrimônio duplicado",
        description: "Números patrimoniais sintéticos repetidos entre bens ativos.",
        count: 7,
      },
      {
        code: "no_responsible",
        severity: "warning",
        title: "Bens sem responsável",
        description: "Bens ativos sem responsável definido.",
        count: 1234,
      },
      {
        code: "sheets_conflicts",
        severity: "info",
        title: "Divergências do Google Sheets",
        description: "Conflitos de sincronização pendentes de revisão.",
        count: 0,
      },
    ],
    unavailable: [],
  };
}

/** Espelho sintético do contrato `/api/v1/ai/insights` (Etapa 4b). */
export interface AiInsightsMock {
  status: "ok" | "unavailable";
  generated_at: string | null;
  items: { kind: "alert_priority" | "executive_summary" | "quality_suggestion"; title: string; text: string }[];
}

/** Espelho sintético do contrato `POST /api/v1/ai/ask` (Etapa 4b). */
export type AiAskMock = { status: "ok"; answer: string; tools_used: string[] } | { status: "unavailable" };

export function defaultAiInsights(): AiInsightsMock {
  return {
    status: "ok",
    generated_at: "2026-10-15T15:00:00Z",
    items: [
      {
        kind: "alert_priority",
        title: "Priorize os duplicados",
        text: "Resolva primeiro o alerta de patrimônio duplicado.\nDepois trate os bens sem responsável.",
      },
      { kind: "executive_summary", title: "Resumo da semana", text: "Panorama sintético do patrimônio da unidade." },
      { kind: "quality_suggestion", title: "Padronizar descrições", text: "Sugestão sintética para revisão humana." },
    ],
  };
}

export function defaultAiAsk(): AiAskMock {
  return { status: "ok", answer: "Existem 1234 bens sem responsável.", tools_used: ["contar_bens"] };
}

/** Espelho sintético do contrato `/api/v1/me/preferences` (Etapa 3 — Aparência). */
export interface PreferencesMock {
  density: "comfortable" | "compact";
  font_scale: 100 | 112 | 125;
  /** Tipo de gráfico de cada painel do dashboard (sempre as 6 chaves resolvidas). */
  dashboard_charts: DashboardChartsMock;
  /** Painéis visíveis e ordem (sempre os 9 ids em `order`). */
  dashboard_layout: DashboardLayoutMock;
  version: number;
}

export type PreferencesMockInput = Partial<Omit<PreferencesMock, "dashboard_charts">> & {
  dashboard_charts?: Partial<DashboardChartsMock>;
};

export interface DashboardChartsMock {
  units: "grouped" | "stacked" | "horizontal";
  status: "pie" | "donut" | "bar";
  monthly: "line" | "area" | "bar";
  location: "stacked" | "grouped" | "horizontal";
  bond: "pie" | "donut" | "bar";
  rooms: "bar" | "horizontal";
}

export const DASHBOARD_CHARTS_ALLOWED: Record<keyof DashboardChartsMock, readonly string[]> = {
  units: ["grouped", "stacked", "horizontal"],
  status: ["pie", "donut", "bar"],
  monthly: ["line", "area", "bar"],
  location: ["stacked", "grouped", "horizontal"],
  bond: ["pie", "donut", "bar"],
  rooms: ["bar", "horizontal"],
};

export function defaultDashboardCharts(): DashboardChartsMock {
  return { units: "grouped", status: "pie", monthly: "line", location: "stacked", bond: "donut", rooms: "horizontal" };
}

/** IDs dos painéis do dashboard, na ordem padrão (contrato `dashboard_layout`). */
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
] as const;
export type DashboardPanelIdMock = (typeof DASHBOARD_PANEL_IDS)[number];

export interface DashboardLayoutMock {
  order: string[];
  hidden: string[];
}

export function defaultDashboardLayout(): DashboardLayoutMock {
  return { order: [...DASHBOARD_PANEL_IDS], hidden: [] };
}

export function defaultPreferences(): PreferencesMock {
  return {
    density: "comfortable",
    font_scale: 100,
    dashboard_charts: defaultDashboardCharts(),
    dashboard_layout: defaultDashboardLayout(),
    version: 0,
  };
}

const PREFS_PATCH_FIELDS = new Set(["density", "font_scale", "dashboard_charts", "dashboard_layout", "version"]);

/** Lista de painéis válida: só ids conhecidos, sem repetição. */
function isPanelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "string" && (DASHBOARD_PANEL_IDS as readonly string[]).includes(id)) &&
    new Set(value).size === value.length
  );
}

/**
 * Aplica `dashboard_layout` do PATCH como o backend: `null` restaura; `order`
 * precisa ser permutação dos 9 ids; `hidden` sem repetição e nunca os 9.
 * `null` retornado = corpo inválido (400).
 */
function applyDashboardLayoutPatch(current: DashboardLayoutMock, raw: unknown): DashboardLayoutMock | null {
  if (raw === undefined) return { order: [...current.order], hidden: [...current.hidden] };
  if (raw === null) return defaultDashboardLayout();
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "order" && key !== "hidden")) return null;
  const order = body.order === undefined ? current.order : body.order;
  const hidden = body.hidden === undefined ? current.hidden : body.hidden;
  if (!isPanelList(order) || order.length !== DASHBOARD_PANEL_IDS.length) return null;
  if (!isPanelList(hidden) || hidden.length >= DASHBOARD_PANEL_IDS.length) return null;
  return { order: [...order], hidden: [...hidden] };
}

/** Corpo do GET como o backend ANTERIOR (sem layout nem chaves novas de gráfico). */
function legacyPreferences(prefs: PreferencesMock): Record<string, unknown> {
  const { units, status, monthly } = prefs.dashboard_charts;
  return {
    density: prefs.density,
    font_scale: prefs.font_scale,
    dashboard_charts: { units, status, monthly },
    version: prefs.version,
  };
}

/** Aplica `dashboard_charts` do PATCH (null restaura o padrão); `null` retornado = corpo inválido (400). */
function applyDashboardChartsPatch(current: DashboardChartsMock, raw: unknown): DashboardChartsMock | null {
  if (raw === undefined) return { ...current };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const next: DashboardChartsMock = { ...current };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in DASHBOARD_CHARTS_ALLOWED)) return null;
    const panel = key as keyof DashboardChartsMock;
    if (value === null) {
      (next[panel] as string) = defaultDashboardCharts()[panel];
    } else if (typeof value === "string" && DASHBOARD_CHARTS_ALLOWED[panel].includes(value)) {
      (next[panel] as string) = value;
    } else {
      return null;
    }
  }
  return next;
}

export interface MockState extends CatalogMockState, AssetMockState, MovementMockState, InventoryMockState {
  catalogImport: CatalogImportMockState;
  accessibleUnitsStatus: number | null;
  lookupListStatus: number | null;
  role: Role;
  aal: "aal1" | "aal2";
  hasVerifiedFactor: boolean;
  /** Fator não verificado existente (tentativa anterior ou enroll em andamento). */
  unverifiedFactorId: string | null;
  enrollQrCode: string;
  adminAccess: AdminAccessMock;
  adminAccessStatus: number | null;
  adminAccessDelayMs: number;
  auditLogs: AuditDetailMock[];
  auditStatus: number | null;
  auditDetailStatus: number | null;
  auditDelayMs: number;
  unitAccess: UnitAccessItemMock[];
  unitAccessStatus: number | null;
  unitAccessDelayMs: number;
  /** Relatórios/exportações (testes podem mutar os status forçados). */
  reports: ReportsMockState;
  /** Estado mutável das configurações de IA (testes podem simular edição concorrente). */
  ai: AiSettingsMock;
  /** Preferências de aparência do próprio usuário (testes podem simular edição concorrente). */
  prefs: PreferencesMock;
  prefsGetStatus: number | null;
  prefsLegacy: boolean;
  alerts: AlertsMock;
  alertsStatus: number | null;
  dashboard: DashboardMockData;
  dashboardStatus: Partial<Record<DashboardEndpoint, number>>;
  aiInsights: AiInsightsMock;
  aiInsightsStatus: number | null;
  aiAsk: AiAskMock;
  aiAskStatus: number | null;
  aiAskDelayMs: number;
  /** Usuários administráveis (contrato `UserSummary`); testes podem mutar. */
  users: UserMock[];
  /** Unidades do escopo do ADM (`GET /api/v1/units`). */
  units: UnitMock[];
  /** Histórico por usuário (`GET /users/<id>/audit`). */
  audit: Record<string, AuditEventMock[]>;
  passwordReset: "sent" | "unavailable";
  storageUnavailable: boolean;
  meHasAvatar: boolean;
  meStatus: number | null;
  usersRateLimitRetryAfter: number | null;
  factorNoticeStatus: number;
  /** `true` após um desafio TOTP verificado nesta aba (step-up do MFA reset). */
  reauthVerified: boolean;
  calls: { method: string; url: string; body: unknown }[];
}

export interface UnitMock {
  id: string;
  code: string;
  name: string;
}

export interface UserMock {
  id: string;
  name: string;
  email: string;
  active: boolean;
  role: Role | null;
  units: UnitMock[];
  has_avatar: boolean;
  created_at: string;
  last_login_at: string | null;
  deactivated_at: string | null;
  version: number;
}

export interface AuditEventMock {
  id: string;
  occurred_at: string;
  operation: string;
  result: string;
  actor: { id: string; name: string } | null;
  changes: Record<string, unknown>;
}

export function defaultAiSettings(): AiSettingsMock {
  return {
    status: "disabled",
    env_enabled: true,
    enabled: false,
    provider: "none",
    model: null,
    features: { alerts_explain: false, executive_summary: false, assistant: false, data_quality: false },
    monthly_token_cap: 200_000,
    deepseek_acknowledged: false,
    keys: { openai: "configured", anthropic: "not_configured", deepseek: "configured" },
    models: {
      openai: ["openai-modelo-sintetico-a", "openai-modelo-sintetico-b"],
      anthropic: ["anthropic-modelo-sintetico-a"],
      deepseek: ["deepseek-modelo-sintetico-a"],
    },
    version: 1,
    updated_at: "2026-10-14T15:00:00Z",
  };
}

const AI_PATCH_FIELDS = new Set([
  "version",
  "enabled",
  "provider",
  "model",
  "features",
  "monthly_token_cap",
  "acknowledge_international_transfer",
]);

function aiStatus(ai: AiSettingsMock): AiSettingsMock["status"] {
  if (!ai.env_enabled || !ai.enabled) return "disabled";
  if (ai.provider === "none" || ai.keys[ai.provider] !== "configured") return "unavailable";
  return "active";
}

export const USER_ID = "00000000-0000-4000-8000-0000000000e2";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function fakeJwt(aal: "aal1" | "aal2" = "aal2"): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      aal,
      email: "pessoa.sintetica@exemplo.invalid",
      iat: now,
      exp: now + 86_400,
    }),
    "assinatura-ficticia-e2e",
  ].join(".");
}

export const DEFAULT_ENROLL_QR_CODE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
export const ENROLL_SECRET = "E2EFICTICIOSECRETAAAAAAAAAAAAAAAA";

function fakeUser(state: Pick<MockState, "hasVerifiedFactor"> & { unverifiedFactorId?: string | null }) {
  const user = {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "pessoa.sintetica@exemplo.invalid",
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    factors: state.hasVerifiedFactor
      ? [
          {
            id: "factor-totp-e2e",
            friendly_name: `Autenticador ${XSS_IMG}`,
            factor_type: "totp",
            status: "verified",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]
      : [],
  };
  if (state.unverifiedFactorId) {
    user.factors.push({
      id: state.unverifiedFactorId,
      friendly_name: "",
      factor_type: "totp",
      status: "unverified",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  }
  return user;
}

export function fakeSession(aal: "aal1" | "aal2" = "aal2", hasVerifiedFactor = true, unverifiedFactorId: string | null = null) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt(aal),
    refresh_token: "refresh-ficticio-e2e",
    token_type: "bearer",
    expires_in: 86_400,
    expires_at: now + 86_400,
    user: fakeUser({ hasVerifiedFactor, unverifiedFactorId }),
  };
}

/** Injeta uma sessão Supabase sintética no localStorage (uma vez por aba). */
export async function seedSession(page: Page, opts: MockOptions = {}): Promise<void> {
  const session = fakeSession(opts.aal ?? "aal2", opts.hasVerifiedFactor ?? opts.role === "ADM");
  await page.addInitScript(
    ([sessionKey, legacyKey, value]) => {
      // O marcador vive em sessionStorage (sobrevive a navegações na mesma
      // aba): a sessão é semeada só na primeira carga, permitindo testar o logout.
      if (window.sessionStorage.getItem("__e2e_seeded")) return;
      window.sessionStorage.setItem("__e2e_seeded", "1");
      window.sessionStorage.setItem(sessionKey, value);
      window.localStorage.setItem(legacyKey, value);
    },
    [SESSION_STORAGE_KEY, LEGACY_STORAGE_KEY, JSON.stringify(session)] as const,
  );
}

function corsHeaders(request: Request): Record<string, string> {
  const headers = request.headers();
  return {
    "access-control-allow-origin": headers["origin"] ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      headers["access-control-request-headers"] ?? "authorization,content-type,apikey,x-client-info",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

async function json(route: Route, status: number, body?: unknown): Promise<void> {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(route.request()), "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function parseBody(request: Request): unknown {
  const raw = request.postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Dados sintéticos da prévia de importação
// ---------------------------------------------------------------------------

type Classification = "NOVO" | "EXISTENTE" | "DUPLICADO" | "INVALIDO" | "CONFLITANTE";

const LONG_DESCRIPTION =
  "Cadeira giratória sintética de teste com braços reguláveis, encosto em tela, base cromada de cinco pés, " +
  "rodízios de nylon e ajuste de altura a gás — descrição propositalmente longa para validar quebra de linha " +
  "em telas de 320px sem rolagem horizontal da página";

export const PREVIEW_ITEMS: {
  id: string;
  source_record_id: string;
  patrimony_number: string;
  description: string;
  classification: Classification;
  selected: boolean;
  validation_errors: string[] | null;
}[] = [
  ["NOVO", "000123", LONG_DESCRIPTION],
  ["NOVO", "000124", `Mesa sintética ${XSS_IMG}`],
  ["EXISTENTE", "000125", `Armário sintético ${XSS_SCRIPT}`],
  ["DUPLICADO", "000126", "Cadeira sintética duplicada na planilha"],
  ["INVALIDO", "", "Registro sintético sem número patrimonial"],
  ["CONFLITANTE", "000128", "Monitor sintético em conflito"],
  ["NOVO", "0001290000000000000000000000000000", "Patrimônio sintético com número muito longo sem espaços"],
  ["EXISTENTE", "000130", "Cadeira sintética existente"],
].map(([classification, num, description], index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  source_record_id: `linha-${index + 2}`,
  patrimony_number: num as string,
  description: description as string,
  classification: classification as Classification,
  selected: classification === "NOVO" || classification === "EXISTENTE",
  validation_errors:
    classification === "INVALIDO" ? ["numero_patrimonial ausente", `campo ${XSS_IMG} inválido`] : null,
}));

// ---------------------------------------------------------------------------
// Gestão de usuários (contrato docs/architecture/modulo-configuracoes.md, Etapa 2)
// ---------------------------------------------------------------------------

export const UNITS: UnitMock[] = [
  { id: "60000000-0000-4000-8000-000000000001", code: "PSU-TO", name: "Procuradoria Seccional Sintética de Palmas" },
  { id: "60000000-0000-4000-8000-000000000002", code: "ESC-02", name: "Escritório Sintético Avançado" },
  { id: "60000000-0000-4000-8000-000000000003", code: "NUC-03", name: `Núcleo Sintético ${XSS_IMG}` },
];

/** Unidade vinculada a um usuário mas FORA do escopo do ADM (não vem em /units). */
export const OUT_OF_SCOPE_UNIT: UnitMock = {
  id: "60000000-0000-4000-8000-000000000009",
  code: "FORA-09",
  name: "Unidade Sintética Fora do Escopo",
};

export const ADMIN_ID = "20000000-0000-4000-8000-000000000001";
export const COMMON_USER_ID = "20000000-0000-4000-8000-000000000002";
export const RH_USER_ID = "20000000-0000-4000-8000-000000000003";

export function defaultUsers(): UserMock[] {
  const [u1, u2] = UNITS as [UnitMock, UnitMock, UnitMock];
  return [
    {
      id: ADMIN_ID,
      name: "Pessoa Sintética Administradora com Nome Bastante Longo para Teste",
      email: "administradora.sintetica.com.email.extremamente.longo@exemplo.invalid",
      active: true,
      role: "ADM",
      units: [u1],
      has_avatar: true,
      created_at: "2026-01-10T12:00:00Z",
      last_login_at: "2026-10-13T18:30:00Z",
      deactivated_at: null,
      version: 3,
    },
    {
      id: COMMON_USER_ID,
      name: `Usuário ${XSS_IMG}`,
      email: "usuario.sintetico@exemplo.invalid",
      active: true,
      role: "USER",
      units: [u1, u2],
      has_avatar: false,
      created_at: "2026-02-01T12:00:00Z",
      last_login_at: null,
      deactivated_at: null,
      version: 1,
    },
    {
      id: RH_USER_ID,
      name: "Pessoa Sintética RH",
      email: "rh.sintetico@exemplo.invalid",
      active: false,
      role: "RH",
      units: [u2, OUT_OF_SCOPE_UNIT],
      has_avatar: false,
      created_at: "2026-03-01T12:00:00Z",
      last_login_at: "2026-08-30T13:00:00Z",
      deactivated_at: "2026-09-01T10:00:00Z",
      version: 2,
    },
    {
      id: USER_ID,
      name: "Pessoa Sintética",
      email: "pessoa.sintetica@exemplo.invalid",
      active: true,
      role: "ADM",
      units: [u1],
      has_avatar: false,
      created_at: "2026-01-01T12:00:00Z",
      last_login_at: "2026-10-14T11:00:00Z",
      deactivated_at: null,
      version: 5,
    },
  ];
}

export function defaultAudit(): Record<string, AuditEventMock[]> {
  const actor = { id: USER_ID, name: "Pessoa Sintética" };
  const adminEvents: AuditEventMock[] = Array.from({ length: 12 }, (_, i) => ({
    id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    occurred_at: new Date(Date.UTC(2026, 9, 13, 18, 0) - i * 3_600_000).toISOString(),
    operation: i % 2 === 0 ? "USER_SESSIONS_REVOKED" : "USER_ACTIVATED",
    result: "SUCESSO",
    actor,
    changes: i % 2 === 0 ? { sessions_revoked_at: "2026-10-13T18:00:00Z" } : { active: { from: false, to: true } },
  }));
  return {
    [ADMIN_ID]: adminEvents,
    [COMMON_USER_ID]: [
      {
        id: "70000000-0000-4000-8000-000000000101",
        occurred_at: "2026-10-10T15:00:00Z",
        operation: "USER_UNITS_CHANGED",
        result: "SUCESSO",
        actor,
        changes: { units: { from: [UNITS[0]], to: [UNITS[0], UNITS[1]] } },
      },
      {
        id: "70000000-0000-4000-8000-000000000102",
        occurred_at: "2026-10-09T12:00:00Z",
        operation: "USER_ROLE_CHANGED",
        result: "SUCESSO",
        actor: null,
        changes: { role: { from: XSS_SCRIPT, to: "USER" } },
      },
    ],
    [RH_USER_ID]: [],
  };
}

/** PNG 1x1 válido (servido como "foto" pela URL assinada sintética). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Imita a checagem de "magic bytes" do backend (JPEG/PNG/WebP). */
function looksLikeImage(buffer: Buffer): boolean {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  return buffer.includes(png) || buffer.includes(jpeg) || /RIFF[\s\S]{4}WEBP/.test(buffer.toString("latin1"));
}

const USER_PATCH_FIELDS = new Set(["version", "role", "unit_ids", "confirm_privilege_change"]);
const USER_LIST_PARAMS = new Set(["q", "role", "unit_id", "active", "sort", "page", "page_size"]);
const USER_SORTS = new Set(["name", "email", "created_at", "last_login_at"]);

async function apiError(route: Route, status: number, code: string, message = "erro sintético"): Promise<true> {
  await json(route, status, { error: { code, message } });
  return true;
}

function serializeUser(user: UserMock): UserMock {
  return { ...user, units: user.units.map((u) => ({ ...u })) };
}

function signedUrl(name: string): { url: string; expires_in: number } {
  return { url: `${SUPABASE_URL}/storage/v1/object/sign/avatars/${name}.webp?token=e2e`, expires_in: 300 };
}

/** Foto do próprio usuário (`/me/avatar*`, qualquer perfil). `true` = tratada. */
async function handleMyAvatar(route: Route, state: MockState, method: string, path: string): Promise<boolean> {
  if (path === "/v1/me/avatar-url" && method === "GET") {
    if (state.storageUnavailable) return apiError(route, 503, "storage_unavailable");
    if (!state.meHasAvatar) return apiError(route, 404, "not_found");
    await json(route, 200, signedUrl("me"));
    return true;
  }
  if (path !== "/v1/me/avatar" || (method !== "PUT" && method !== "DELETE")) return false;
  if (state.storageUnavailable) return apiError(route, 503, "storage_unavailable");
  if (method === "DELETE") {
    state.meHasAvatar = false;
    await json(route, 204);
    return true;
  }
  const buffer = route.request().postDataBuffer() ?? Buffer.alloc(0);
  if (buffer.length > AVATAR_MAX_BYTES) return apiError(route, 413, "file_too_large");
  if (!looksLikeImage(buffer)) return apiError(route, 400, "unsupported_image");
  state.meHasAvatar = true;
  await json(route, 200, { has_avatar: true });
  return true;
}

/**
 * Telas de CONSULTA (todos os perfis): `GET /v1/units/accessible` (contrato novo:
 * `{units:[{id,code,name,active}]}`, sem parâmetros, escopo do usuário) e erros
 * forçados nas listagens de salas/pessoas. ADM sem AAL2 => 403 AAL2_REQUIRED.
 */
async function handleLookup(route: Route, state: MockState, method: string, path: string, url: URL): Promise<boolean> {
  const isAccessible = path === "/v1/units/accessible" && method === "GET";
  const isList = (path === "/v1/rooms" || path === "/v1/responsible-people") && method === "GET";
  if (!isAccessible && !isList) return false;
  const forced = isAccessible ? state.accessibleUnitsStatus : state.lookupListStatus;
  if (forced && forced >= 400) return apiError(route, forced, forced === 403 ? "FORBIDDEN" : "INTERNAL", "SISPAT_BACKEND_MSG");
  if (!isAccessible) return false; // listagens seguem para o handler do catálogo
  if (state.role === "ADM" && state.aal !== "aal2") return apiError(route, 403, "AAL2_REQUIRED", "MFA obrigatório");
  if ([...url.searchParams.keys()].length > 0) return apiError(route, 400, "validation_error");
  await json(route, 200, {
    units: Object.values(state.unitDetails).map((u) => ({ id: u.id, code: u.code, name: u.name, active: u.active })),
  });
  return true;
}

/** Rotas administrativas de usuários/unidades (ADM + AAL2). `true` = tratada. */
async function handleUserAdmin(
  route: Route,
  state: MockState,
  method: string,
  path: string,
  url: URL,
  body: unknown,
): Promise<boolean> {
  const isAdminRoute = path === "/v1/units" || /^\/v1\/users(\/[^/]+(\/[a-z-]+)?)?$/.test(path);
  if (!isAdminRoute) return false;
  // Convite, ativação e a revogação legada seguem nos handlers antigos.
  if (path === "/v1/users/invite" || path === "/v1/users/activate-invite" || /\/revoke$/.test(path)) return false;

  // Como o backend: USER/RH → 403; ADM em aal1 → 403 AAL2_REQUIRED.
  if (state.role !== "ADM") return apiError(route, 403, "FORBIDDEN", "Proibido");
  if (state.aal !== "aal2") return apiError(route, 403, "AAL2_REQUIRED", "MFA obrigatório");

  if (path === "/v1/units" && method === "GET") {
    await json(route, 200, { units: state.units });
    return true;
  }

  if (path === "/v1/users" && method === "GET") {
    for (const key of url.searchParams.keys()) {
      if (!USER_LIST_PARAMS.has(key)) return apiError(route, 400, "validation_error");
    }
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const role = url.searchParams.get("role");
    const unitId = url.searchParams.get("unit_id");
    const active = url.searchParams.get("active");
    const sort = url.searchParams.get("sort") ?? "name";
    const page = mockPage(url.searchParams);
    const pageSize = mockPageSize(url.searchParams);
    const field = sort.replace(/^-/, "");
    if (!USER_SORTS.has(field) || q.length > 100 || page === null || pageSize === null) {
      return apiError(route, 400, "validation_error");
    }
    if (url.searchParams.getAll("q").length > 1 || (active !== null && active !== "true" && active !== "false")) {
      return apiError(route, 400, "validation_error");
    }
    const dir = sort.startsWith("-") ? -1 : 1;
    const list = state.users
      .filter(
        (u) =>
          (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
          (!role || u.role === role) &&
          (!unitId || u.units.some((unit) => unit.id === unitId)) &&
          (active === null || String(u.active) === active),
      )
      .sort((a, b) => {
        const va = (a as unknown as Record<string, string | null>)[field] ?? null;
        const vb = (b as unknown as Record<string, string | null>)[field] ?? null;
        if (va === vb) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return va.localeCompare(vb, "pt-BR") * dir;
      });
    await json(route, 200, {
      total: list.length,
      page,
      page_size: pageSize,
      users: list.slice((page - 1) * pageSize, page * pageSize).map(serializeUser),
    });
    return true;
  }

  const match = path.match(/^\/v1\/users\/([^/]+)(?:\/([a-z-]+))?$/);
  if (!match) return false;
  const [, id, action] = match;
  const user = state.users.find((u) => u.id === id);
  // Inexistente, fora do escopo ou malformado: o MESMO 404.
  if (!user) return apiError(route, 404, "not_found", "Não encontrado");
  const payload = (body ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const log = (operation: string, changes: Record<string, unknown>) => {
    const list = (state.audit[user.id] ??= []);
    list.unshift({
      id: `7f000000-0000-4000-8000-${String(list.length + 1).padStart(12, "0")}`,
      occurred_at: now,
      operation,
      result: "SUCESSO",
      actor: { id: USER_ID, name: "Pessoa Sintética" },
      changes,
    });
  };
  const activeAdmins = () => state.users.filter((u) => u.role === "ADM" && u.active);

  if (!action && method === "GET") {
    await json(route, 200, serializeUser(user));
    return true;
  }

  if (!action && method === "PATCH") {
    if (Object.keys(payload).some((key) => !USER_PATCH_FIELDS.has(key))) {
      return apiError(route, 400, "validation_error");
    }
    if (payload.version !== user.version) return apiError(route, 409, "version_conflict");
    if (user.id === USER_ID) return apiError(route, 409, "self_change_forbidden");
    const nextRole = (payload.role as Role | undefined) ?? user.role;
    const privilege = nextRole !== user.role && (nextRole === "ADM" || user.role === "ADM");
    if (privilege && payload.confirm_privilege_change !== true) return apiError(route, 400, "confirmation_required");
    if (user.role === "ADM" && nextRole !== "ADM" && user.active && activeAdmins().length <= 1) {
      return apiError(route, 409, "last_admin");
    }
    const unitIds = payload.unit_ids as string[] | undefined;
    if (unitIds !== undefined) {
      if (unitIds.length < 1 || unitIds.length > 50) return apiError(route, 400, "validation_error");
      if (unitIds.some((uid) => !state.units.some((u) => u.id === uid))) {
        return apiError(route, 403, "unit_out_of_scope");
      }
    }
    if (nextRole !== user.role) {
      log("USER_ROLE_CHANGED", { role: { from: user.role, to: nextRole } });
      user.role = nextRole;
    }
    if (unitIds !== undefined) {
      const kept = user.units.filter((u) => !state.units.some((s) => s.id === u.id));
      const next = [...state.units.filter((u) => unitIds.includes(u.id)), ...kept];
      log("USER_UNITS_CHANGED", { units: { from: user.units, to: next } });
      user.units = next;
    }
    user.version += 1;
    await json(route, 200, serializeUser(user));
    return true;
  }

  if (method === "POST" && (action === "deactivate" || action === "activate")) {
    if (payload.version !== user.version) return apiError(route, 409, "version_conflict");
    if (user.id === USER_ID) return apiError(route, 409, "self_change_forbidden");
    if (action === "deactivate") {
      if (user.role === "ADM" && user.active && activeAdmins().length <= 1) return apiError(route, 409, "last_admin");
      user.active = false;
      user.deactivated_at = now;
      log("USER_DEACTIVATED", { active: { from: true, to: false } });
    } else {
      user.active = true;
      user.deactivated_at = null;
      log("USER_ACTIVATED", { active: { from: false, to: true } });
    }
    user.version += 1;
    await json(route, 200, serializeUser(user));
    return true;
  }

  if (method === "POST" && action === "revoke-sessions") {
    log("USER_SESSIONS_REVOKED", { sessions_revoked_at: now });
    await json(route, 200, { sessions_revoked_at: now });
    return true;
  }

  if (method === "POST" && action === "password-reset") {
    await json(route, 200, { result: state.passwordReset });
    return true;
  }

  if (method === "POST" && action === "mfa-reset") {
    if (user.id === USER_ID) return apiError(route, 409, "self_change_forbidden");
    if (!state.reauthVerified) return apiError(route, 403, "REAUTH_REQUIRED", "Reautenticação necessária");
    log("USER_MFA_RESET", {});
    await json(route, 200, { removed_factors: 1 });
    return true;
  }

  if (method === "GET" && action === "audit") {
    const page = mockPage(url.searchParams);
    const pageSize = mockPageSize(url.searchParams);
    if (page === null || pageSize === null) return apiError(route, 400, "validation_error");
    const events = state.audit[user.id] ?? [];
    await json(route, 200, {
      total: events.length,
      page,
      page_size: pageSize,
      events: events.slice((page - 1) * pageSize, page * pageSize),
    });
    return true;
  }

  if (action === "avatar-url" && method === "GET") {
    if (state.storageUnavailable) return apiError(route, 503, "storage_unavailable");
    if (!user.has_avatar) return apiError(route, 404, "not_found");
    await json(route, 200, signedUrl(user.id));
    return true;
  }

  if (action === "avatar" && (method === "PUT" || method === "DELETE")) {
    if (state.storageUnavailable) return apiError(route, 503, "storage_unavailable");
    if (method === "DELETE") {
      user.has_avatar = false;
      log("USER_AVATAR_REMOVED", { avatar: { from: true, to: false } });
      await json(route, 204);
      return true;
    }
    const buffer = route.request().postDataBuffer() ?? Buffer.alloc(0);
    if (buffer.length > AVATAR_MAX_BYTES) return apiError(route, 413, "file_too_large");
    if (!looksLikeImage(buffer)) return apiError(route, 400, "unsupported_image");
    user.has_avatar = true;
    log("USER_AVATAR_UPDATED", { avatar: { from: false, to: true } });
    await json(route, 200, { has_avatar: true });
    return true;
  }

  return false;
}

const PERMISSIONS: Record<Role, string[]> = {
  ADM: [
    "users.manage",
    "users.invite",
    "users.assign_role",
    "users.assign_unit",
    "users.deactivate",
    "users.activate",
    "users.revoke_sessions",
    "users.reset_password",
    "users.reset_mfa",
    "users.avatar.manage",
    "audit.read",
    "imports.execute",
  ],
  USER: ["assets.read"],
  RH: ["assets.read"],
};

/**
 * Instala os mocks na página. Retorna o estado (inclui o log de chamadas
 * para asserções). Toda requisição externa não mockada é abortada.
 */
export async function installMocks(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = {
    role: opts.role ?? "ADM",
    aal: opts.aal ?? "aal2",
    hasVerifiedFactor: opts.hasVerifiedFactor ?? (opts.role ?? "ADM") === "ADM",
    unverifiedFactorId: opts.hasStaleUnverifiedFactor ? "factor-stale-e2e" : null,
    enrollQrCode: opts.enrollQrCode ?? DEFAULT_ENROLL_QR_CODE,
    adminAccess: opts.adminAccess ?? defaultAdminAccess(),
    adminAccessStatus: opts.adminAccessStatus ?? null,
    adminAccessDelayMs: opts.adminAccessDelayMs ?? 0,
    auditLogs: opts.auditLogs ?? defaultAuditLogs(),
    auditStatus: opts.auditStatus ?? null,
    auditDetailStatus: opts.auditDetailStatus ?? null,
    auditDelayMs: opts.auditDelayMs ?? 0,
    unitAccess: opts.unitAccess ?? defaultUnitAccess(),
    unitAccessStatus: opts.unitAccessStatus ?? null,
    unitAccessDelayMs: opts.unitAccessDelayMs ?? 0,
    reports: defaultReportsState(opts.reports),
    ai: { ...defaultAiSettings(), ...opts.ai },
    prefs: {
      ...defaultPreferences(),
      ...opts.prefs,
      dashboard_charts: { ...defaultDashboardCharts(), ...opts.prefs?.dashboard_charts },
      dashboard_layout: opts.prefs?.dashboard_layout ?? defaultDashboardLayout(),
    },
    prefsGetStatus: opts.prefsGetStatus ?? null,
    prefsLegacy: opts.prefsLegacy ?? false,
    users: defaultUsers(),
    units: UNITS.map((u) => ({ ...u })),
    audit: defaultAudit(),
    passwordReset: opts.passwordReset ?? "sent",
    storageUnavailable: opts.storageUnavailable ?? false,
    meHasAvatar: opts.meHasAvatar ?? false,
    meStatus: opts.meStatus ?? null,
    usersRateLimitRetryAfter: opts.usersRateLimitRetryAfter ?? null,
    alerts: opts.alerts ?? defaultAlerts(),
    alertsStatus: opts.alertsStatus ?? null,
    dashboard: { ...defaultDashboard(), ...opts.dashboard },
    dashboardStatus: { ...opts.dashboardStatus },
    aiInsights: opts.aiInsights ?? defaultAiInsights(),
    aiInsightsStatus: opts.aiInsightsStatus ?? null,
    aiAsk: opts.aiAsk ?? defaultAiAsk(),
    aiAskStatus: opts.aiAskStatus ?? null,
    aiAskDelayMs: opts.aiAskDelayMs ?? 0,
    factorNoticeStatus: opts.factorNoticeStatus ?? 204,
    ...defaultCatalog(UNITS, { hidePhone: opts.catalogHidePhone, hideAddress: opts.catalogHideAddress }),
    ...defaultAssets(UNITS),
    forceListStatus: opts.assetsListStatus ?? null,
    forceBondStatusesStatus: opts.assetBondStatusesStatus ?? null,
    ...defaultMovements(UNITS),
    forceMovementListStatus: opts.movementsListStatus ?? null,
    ...defaultInventories(UNITS),
    forceInventoryListStatus: opts.inventoriesListStatus ?? null,
    catalogImport: defaultCatalogImport(opts.catalogImport),
    accessibleUnitsStatus: opts.accessibleUnitsStatus ?? null,
    lookupListStatus: opts.lookupListStatus ?? null,
    reauthVerified: false,
    calls: [],
  };

  // 1) Bloqueio de rede externa (registrado primeiro = menor prioridade).
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );

  // 2) Supabase Auth sintético.
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = parseBody(request);
    state.calls.push({ method, url: url.pathname + url.search, body });

    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(request) });

    // URL assinada sintética do bucket privado `avatars` (Supabase Storage).
    if (url.pathname.startsWith("/storage/v1/object/sign/avatars/")) {
      return route.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: TINY_PNG });
    }

    const path = url.pathname.replace(/^\/auth\/v1/, "");
    if (path === "/token" && url.searchParams.get("grant_type") === "password") {
      const email = (body as { email?: string } | undefined)?.email ?? "";
      // Login: "rede..." = conexão derrubada; "limite..." = 429 do Supabase Auth.
      if (email.startsWith("rede")) return route.abort("failed");
      if (email.startsWith("limite")) {
        return json(route, 429, { code: "over_request_rate_limit", msg: "Too many requests" });
      }
      if (email.startsWith("invalido")) {
        return json(route, 400, {
          code: "invalid_credentials",
          error: "invalid_grant",
          error_description: "Invalid login credentials",
          msg: "Invalid login credentials",
        });
      }
      return json(route, 200, fakeSession(state.aal, state.hasVerifiedFactor, state.unverifiedFactorId));
    }
    // verifyOtp({ token_hash, type: "invite" }): só o hash válido sintético cria sessão.
    if (path === "/verify" && method === "POST") {
      const hash = (body as { token_hash?: string } | undefined)?.token_hash;
      if (hash === VALID_INVITE_TOKEN_HASH) return json(route, 200, fakeSession("aal1", false));
      return json(route, 403, {
        code: "otp_expired",
        error_code: "otp_expired",
        msg: "Email link is invalid or has expired",
      });
    }
    if (path === "/user" && method === "GET") return json(route, 200, fakeUser(state));
    if (path === "/user" && method === "PUT") return json(route, 200, fakeUser(state));
    if (path === "/logout") return json(route, 204);
    if (path === "/factors" && method === "POST") {
      state.unverifiedFactorId = "factor-novo-e2e";
      return json(route, 200, {
        id: "factor-novo-e2e",
        type: "totp",
        friendly_name: "",
        totp: {
          qr_code: state.enrollQrCode,
          secret: ENROLL_SECRET,
          uri: "otpauth://totp/SISPAT-E2E:sintetico?secret=E2EFICTICIO",
        },
      });
    }
    const removal = path.match(/^\/factors\/([^/]+)$/);
    if (removal && method === "DELETE") {
      if (state.unverifiedFactorId === removal[1]) state.unverifiedFactorId = null;
      return json(route, 200, { id: removal[1] });
    }
    const challenge = path.match(/^\/factors\/([^/]+)\/challenge$/);
    if (challenge) {
      return json(route, 200, {
        id: "challenge-e2e",
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }
    const verify = path.match(/^\/factors\/([^/]+)\/verify$/);
    if (verify) {
      const code = (body as { code?: string } | undefined)?.code;
      if (code !== "123456") {
        return json(route, 422, { code: "mfa_verification_failed", msg: "Invalid TOTP code" });
      }
      state.aal = "aal2";
      state.hasVerifiedFactor = true;
      state.unverifiedFactorId = null;
      // Step-up: uma verificação TOTP recente libera o `mfa-reset` (REAUTH_REQUIRED).
      state.reauthVerified = true;
      return json(route, 200, fakeSession("aal2", true));
    }
    return json(route, 404, { msg: `rota Supabase não mockada: ${method} ${path}` });
  });

  // 3) API Flask sintética.
  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const multipart = (request.headers()["content-type"] ?? "").startsWith("multipart/form-data");
    const body = multipart
      ? { multipart: true, bytes: request.postDataBuffer()?.length ?? 0 }
      : parseBody(request);
    state.calls.push({ method, url: url.pathname + url.search, body });

    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(request) });

    // Como o backend real: sem Bearer => 401 (exceto ativação, que também exige).
    const auth = request.headers()["authorization"] ?? "";
    if (!auth.startsWith("Bearer ")) {
      return json(route, 401, { error: { code: "UNAUTHENTICATED", message: "Não autenticado" } });
    }

    const path = url.pathname.replace(/^\/api/, "");

    if (path === "/v1/me" && state.meStatus && state.meStatus >= 400) {
      return json(route, state.meStatus, { error: { code: "UNAUTHENTICATED", message: "Não autenticado" } });
    }

    if (path === "/v1/users" && method === "GET" && state.usersRateLimitRetryAfter !== null) {
      const seconds = state.usersRateLimitRetryAfter;
      return route.fulfill({
        status: 429,
        headers: {
          ...corsHeaders(request),
          "content-type": "application/json",
          "access-control-expose-headers": "Retry-After",
          ...(seconds > 0 ? { "retry-after": String(seconds) } : {}),
        },
        body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "SISPAT_BACKEND_MSG" } }),
      });
    }

    if (path === "/v1/me") {
      return json(route, 200, {
        id: USER_ID,
        name: "Pessoa Sintética",
        email: "pessoa.sintetica@exemplo.invalid",
        roles: [state.role],
        permissions: PERMISSIONS[state.role],
        current_aal: state.aal,
        mfa_required: state.role === "ADM",
        has_avatar: state.meHasAvatar,
      });
    }

    if (
      await handleDashboard({
        state,
        method,
        path,
        query: url.searchParams,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }

    if (path === "/v1/dashboard/alerts" && method === "GET") {
      if (state.alertsStatus && state.alertsStatus >= 400) {
        return json(route, state.alertsStatus, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
      }
      return json(route, 200, state.alerts);
    }

    if (path === "/v1/ai/insights" && method === "GET") {
      if (state.aiInsightsStatus && state.aiInsightsStatus >= 400) {
        return json(route, state.aiInsightsStatus, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
      }
      return json(route, 200, state.aiInsights);
    }

    if (path === "/v1/ai/ask" && method === "POST") {
      if (state.aiAskDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.aiAskDelayMs));
      if (state.aiAskStatus && state.aiAskStatus >= 400) {
        return json(route, state.aiAskStatus, { error: { code: "AI_ERROR", message: "SISPAT_BACKEND_MSG" } });
      }
      return json(route, 200, state.aiAsk);
    }

    if (path === "/v1/me/preferences" && (method === "GET" || method === "PATCH")) {
      if (method === "GET") {
        if (state.prefsGetStatus && state.prefsGetStatus >= 400) {
          return json(route, state.prefsGetStatus, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
        }
        return json(route, 200, state.prefsLegacy ? legacyPreferences(state.prefs) : state.prefs);
      }
      const patch = (body ?? {}) as Record<string, unknown>;
      const density = patch.density ?? state.prefs.density;
      const fontScale = patch.font_scale ?? state.prefs.font_scale;
      const charts = applyDashboardChartsPatch(state.prefs.dashboard_charts, patch.dashboard_charts);
      const layout = applyDashboardLayoutPatch(state.prefs.dashboard_layout, patch.dashboard_layout);
      if (
        charts === null ||
        layout === null ||
        Object.keys(patch).some((key) => !PREFS_PATCH_FIELDS.has(key)) ||
        !["comfortable", "compact"].includes(density as string) ||
        ![100, 112, 125].includes(fontScale as number)
      ) {
        return json(route, 400, { error: { code: "validation_error", message: "Campo não permitido" } });
      }
      if (patch.version !== state.prefs.version) {
        return json(route, 409, { error: { code: "version_conflict", message: "Versão desatualizada" } });
      }
      state.prefs = {
        density: density as PreferencesMock["density"],
        font_scale: fontScale as PreferencesMock["font_scale"],
        dashboard_charts: charts,
        dashboard_layout: layout,
        version: state.prefs.version + 1,
      };
      return json(route, 200, state.prefs);
    }

    if (await handleLookup(route, state, method, path, url)) return;
    if (
      await handleAssets({
        state,
        method,
        path,
        searchParams: url.searchParams,
        rawKeys: [...url.searchParams.keys()],
        body,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }
    if (
      await handleMovements({
        state,
        method,
        path,
        searchParams: url.searchParams,
        rawKeys: [...url.searchParams.keys()],
        body,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }
    if (await handleReports({ route, state, method, path, url, cors: corsHeaders(request) })) return;
    if (
      await handleInventories({
        state,
        method,
        path,
        searchParams: url.searchParams,
        rawKeys: [...url.searchParams.keys()],
        body,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }
    if (await handleMyAvatar(route, state, method, path)) return;
    if (await handleUserAdmin(route, state, method, path, url, body)) return;
    if (
      await handleCatalog({
        state,
        method,
        path,
        searchParams: url.searchParams,
        body,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }
    if (
      await handleCatalogImports({
        state: { ...state.catalogImport, role: state.role, aal: state.aal },
        method,
        path,
        searchParams: url.searchParams,
        body,
        respond: (status, payload) => json(route, status, payload),
      })
    ) {
      return;
    }

    if (path === "/v1/users/invite" && method === "POST") {
      const email = (body as { email?: string } | undefined)?.email ?? "";
      if (email.startsWith("duplicado")) {
        return json(route, 409, { error: { code: "INVITE_PENDING", message: "Convite pendente" } });
      }
      return json(route, 201, {
        id: "30000000-0000-4000-8000-000000000001",
        email,
        name: (body as { name?: string }).name,
        intended_role_code: (body as { intended_role_code?: string }).intended_role_code,
        status: "PENDING",
        unit_ids: (body as { unit_ids?: string[] }).unit_ids,
      });
    }

    if (path === "/v1/users/activate-invite" && method === "POST") {
      return json(route, 200, { role: "USER", units: [] });
    }

    // Vínculos usuário x unidades (somente leitura): ADM + AAL2, query em allowlist.
    if (path === "/v1/admin/unit-access" && method === "GET") {
      if (state.unitAccessDelayMs > 0) await new Promise((r) => setTimeout(r, state.unitAccessDelayMs));
      if (state.unitAccessStatus) {
        return json(route, state.unitAccessStatus, { error: { code: "ERRO", message: "detalhe interno sintético" } });
      }
      if (state.role !== "ADM") return json(route, 403, { error: { code: "FORBIDDEN", message: "Proibido" } });
      if (state.aal !== "aal2") {
        return json(route, 403, { error: { code: "AAL2_REQUIRED", message: "MFA obrigatório" } });
      }
      const result = queryUnitAccess(state.unitAccess, url.searchParams);
      if (!result) return json(route, 400, { error: { code: "validation_error", message: "Consulta inválida" } });
      return json(route, 200, result);
    }

    // Perfis e permissões (somente leitura): ADM + AAL2 (USER/RH → 403; ADM aal1 → AAL2_REQUIRED).
    if ((path === "/v1/admin/roles" || path === "/v1/admin/permissions") && method === "GET") {
      if (state.adminAccessDelayMs > 0) await new Promise((r) => setTimeout(r, state.adminAccessDelayMs));
      if (state.adminAccessStatus) {
        return json(route, state.adminAccessStatus, { error: { code: "ERRO", message: "detalhe interno sintético" } });
      }
      if (state.role !== "ADM") return json(route, 403, { error: { code: "FORBIDDEN", message: "Proibido" } });
      if (state.aal !== "aal2") {
        return json(route, 403, { error: { code: "AAL2_REQUIRED", message: "MFA obrigatório" } });
      }
      if (path === "/v1/admin/roles") {
        return json(route, 200, { roles: state.adminAccess.roles, users_count_scope: "actor_units" });
      }
      return json(route, 200, { permissions: state.adminAccess.permissions });
    }

    // Auditoria (somente leitura): ADM + AAL2; filtros por allowlist como o backend.
    if (path.startsWith("/v1/admin/audit-logs") && method === "GET") {
      if (state.auditDelayMs > 0) await new Promise((r) => setTimeout(r, state.auditDelayMs));
      const detailId = path.slice("/v1/admin/audit-logs/".length);
      const isDetail = path.length > "/v1/admin/audit-logs".length;
      const forced = isDetail ? state.auditDetailStatus : state.auditStatus;
      if (forced) return json(route, forced, { error: { code: "ERRO", message: "detalhe interno sintético" } });
      if (state.role !== "ADM") return json(route, 403, { error: { code: "FORBIDDEN", message: "Proibido" } });
      if (state.aal !== "aal2") {
        return json(route, 403, { error: { code: "AAL2_REQUIRED", message: "MFA obrigatório" } });
      }
      const reply = isDetail
        ? auditDetailReply(state.auditLogs, detailId, url.searchParams)
        : auditListReply(state.auditLogs, url.searchParams);
      return json(route, reply.status, reply.body);
    }

    // Configurações de IA: ADM + AAL2 (como o backend: USER/RH → 403; ADM aal1 → AAL2_REQUIRED).
    if (path === "/v1/settings/ai" || path === "/v1/settings/ai/test") {
      if (state.role !== "ADM") return json(route, 403, { error: { code: "FORBIDDEN", message: "Proibido" } });
      if (state.aal !== "aal2") {
        return json(route, 403, { error: { code: "AAL2_REQUIRED", message: "MFA obrigatório" } });
      }
      const ai = state.ai;
      if (path === "/v1/settings/ai/test" && method === "POST") {
        if (!ai.env_enabled || !ai.enabled) return json(route, 200, { result: "disabled" });
        if (ai.provider === "none" || ai.keys[ai.provider] !== "configured") {
          return json(route, 200, { result: "not_configured" });
        }
        return json(route, 200, { result: "ok", latency_ms: 840 });
      }
      if (path === "/v1/settings/ai" && method === "GET") return json(route, 200, ai);
      if (path === "/v1/settings/ai" && method === "PATCH") {
        const patch = (body ?? {}) as Record<string, unknown>;
        if (Object.keys(patch).some((key) => !AI_PATCH_FIELDS.has(key))) {
          return json(route, 400, { error: { code: "validation_error", message: "Campo não permitido" } });
        }
        if (patch.version !== ai.version) {
          return json(route, 409, { error: { code: "version_conflict", message: "Versão desatualizada" } });
        }
        const provider = (patch.provider as AiSettingsMock["provider"] | undefined) ?? ai.provider;
        if (provider === "deepseek" && !ai.deepseek_acknowledged && patch.acknowledge_international_transfer !== true) {
          return json(route, 400, { error: { code: "deepseek_ack_required", message: "Aceite obrigatório" } });
        }
        const model = (patch.model as string | undefined) ?? (provider === ai.provider ? ai.model : null);
        if (provider !== "none" && model !== null && !ai.models[provider].includes(model)) {
          return json(route, 400, { error: { code: "invalid_model", message: "Modelo inválido" } });
        }
        const next: AiSettingsMock = {
          ...ai,
          enabled: (patch.enabled as boolean | undefined) ?? ai.enabled,
          provider,
          model: provider === "none" ? null : model,
          features: { ...ai.features, ...(patch.features as Partial<AiSettingsMock["features"]> | undefined) },
          monthly_token_cap: (patch.monthly_token_cap as number | undefined) ?? ai.monthly_token_cap,
          deepseek_acknowledged: ai.deepseek_acknowledged || patch.acknowledge_international_transfer === true,
          version: ai.version + 1,
          updated_at: new Date().toISOString(),
        };
        next.status = aiStatus(next);
        state.ai = next;
        return json(route, 200, next);
      }
    }

    if (/^\/v1\/users\/[^/]+\/revoke$/.test(path)) return json(route, 204);
    if (/^\/v1\/security\/mfa\/factors\/[^/]+$/.test(path)) return json(route, 204);
    if (path === "/v1/security/mfa/factor-added-notice" && method === "POST") {
      if (state.factorNoticeStatus >= 400) {
        return json(route, state.factorNoticeStatus, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
      }
      return json(route, 204);
    }

    if (path === "/v1/imports/google-sheets/preview" && method === "POST") {
      const count = (c: Classification) => PREVIEW_ITEMS.filter((i) => i.classification === c).length;
      return json(route, 201, {
        preview_id: "40000000-0000-4000-8000-000000000001",
        summary: {
          total: PREVIEW_ITEMS.length,
          novo: count("NOVO"),
          existente: count("EXISTENTE"),
          duplicado: count("DUPLICADO"),
          invalido: count("INVALIDO"),
          conflitante: count("CONFLITANTE"),
        },
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        pending_counts: PENDING_COUNTS_MOCK,
      });
    }

    if (/^\/v1\/imports\/google-sheets\/preview\/[^/]+\/items$/.test(path)) {
      const status = url.searchParams.get("status");
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("page_size") ?? 50);
      // Contrato do backend: só status/search/page/page_size; page_size ∈ {50,100,200}.
      const allowedKeys = new Set(["status", "search", "page", "page_size"]);
      if ([...url.searchParams.keys()].some((k) => !allowedKeys.has(k)) || ![50, 100, 200].includes(pageSize)) {
        return json(route, 400, { error: { code: "validation_error", message: "Parâmetros inválidos." } });
      }
      const filtered = PREVIEW_ITEMS.filter(
        (i) =>
          (!status || i.classification === status) &&
          (!search ||
            i.patrimony_number.toLowerCase().includes(search) ||
            i.description.toLowerCase().includes(search)),
      );
      return json(route, 200, {
        total: filtered.length,
        page,
        page_size: pageSize,
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
      });
    }

    if (path === "/v1/imports/google-sheets/confirm" && method === "POST") {
      const ids = (body as { selected_item_ids?: string[] }).selected_item_ids ?? [];
      return json(route, 200, {
        sync_job_id: "50000000-0000-4000-8000-000000000001",
        created: ids.length,
        updated: 0,
        ignorados: 0,
        falhas: [],
      });
    }

    return json(route, 404, { error: { code: "NOT_FOUND", message: `não mockado: ${method} ${path}` } });
  });

  return state;
}

/** Espera o React hidratar (handlers ligados) antes de interagir. */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return !!main && Object.keys(main).some((key) => key.startsWith("__react"));
  });
}

/** Garante que nenhum marcador XSS executou e nenhum <img src=x> foi injetado. */
export async function expectNoXss(page: Page): Promise<{ executed: unknown; injectedImgs: number }> {
  return page.evaluate(() => ({
    executed: (window as unknown as { __xss?: unknown }).__xss,
    injectedImgs: document.querySelectorAll('img[src="x"]').length,
  }));
}
