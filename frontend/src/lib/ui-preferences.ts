// =============================================================================
// SISPAT-AGU — ui-preferences.ts
// =============================================================================
// Preferências de APARÊNCIA (densidade + tamanho de fonte) e o cookie NÃO
// sensível `sispat-ui` que evita o "flash" na primeira pintura.
//
// - Fonte de verdade: o backend (`/api/v1/me/preferences`). O cookie é só um
//   cache de apresentação, lido no servidor por `app/layout.tsx` para pôr
//   `data-density`/`data-font-scale` no <html> antes da hidratação.
// - Formato do valor: `<density>.<font_scale>` (ex.: `compact.112`). Parse
//   ESTRITO com allowlist; qualquer outra coisa vira os padrões.
// - Nunca guarda token, e-mail, id ou qualquer dado pessoal. Escrito pelo
//   navegador com SameSite=Lax, Path=/ (não HttpOnly: precisa ser gravado por
//   JS depois de o backend confirmar). Tokens NUNCA vão a localStorage.
//
// Módulo isomórfico (sem "use client"): usado pelo layout (servidor) e pelo
// cliente. As funções que tocam `document` só rodam no navegador.
// =============================================================================

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const FONT_SCALES = [100, 112, 125] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export interface UiPreferences {
  density: Density;
  font_scale: FontScale;
}

export const UI_COOKIE_NAME = "sispat-ui";
export const DEFAULT_UI_PREFERENCES: UiPreferences = { density: "comfortable", font_scale: 100 };

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const COOKIE_PATTERN = /^(comfortable|compact)\.(100|112|125)$/;

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

export function isFontScale(value: unknown): value is FontScale {
  return typeof value === "number" && (FONT_SCALES as readonly number[]).includes(value);
}

/** Parse estrito do cookie; valor ausente/inválido → padrões (sem lançar). */
export function parseUiCookie(raw: string | null | undefined): UiPreferences {
  if (typeof raw !== "string") return { ...DEFAULT_UI_PREFERENCES };
  const match = COOKIE_PATTERN.exec(raw);
  if (!match) return { ...DEFAULT_UI_PREFERENCES };
  return { density: match[1] as Density, font_scale: Number(match[2]) as FontScale };
}

export function serializeUiCookie(prefs: UiPreferences): string {
  return `${prefs.density}.${prefs.font_scale}`;
}

/** Aplica os atributos no <html> (a CSS global reage a eles). Só no navegador. */
export function applyUiPreferences(prefs: UiPreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-density", prefs.density);
  root.setAttribute("data-font-scale", String(prefs.font_scale));
}

/** Grava o cookie `sispat-ui` (SameSite=Lax, Path=/, sem dados sensíveis). */
export function writeUiCookie(prefs: UiPreferences): void {
  if (typeof document === "undefined") return;
  if (!isDensity(prefs.density) || !isFontScale(prefs.font_scale)) return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${UI_COOKIE_NAME}=${serializeUiCookie(prefs)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/**
 * Apaga o cookie `sispat-ui` (Max-Age=0, mesmo Path/SameSite) no logout e
 * quando a sessão expira (401): a preferência de um usuário não pode vazar
 * para o próximo no mesmo navegador. Também volta o <html> aos padrões.
 */
export function clearUiCookie(): void {
  if (typeof document === "undefined") return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${UI_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  applyUiPreferences(DEFAULT_UI_PREFERENCES);
}

/** Depois de o backend CONFIRMAR: grava o cookie e aplica no <html>. */
export function persistUiPreferences(prefs: UiPreferences): void {
  writeUiCookie(prefs);
  applyUiPreferences(prefs);
}
