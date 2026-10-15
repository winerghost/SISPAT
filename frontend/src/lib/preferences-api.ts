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

export interface MyPreferences {
  density: Density;
  font_scale: FontScale;
  /** 0 = nunca gravada (padrões). Enviar de volta no PATCH. */
  version: number;
}

/** Corpo do PATCH: `version` obrigatório; só os campos alterados. */
export interface MyPreferencesUpdate {
  version: number;
  density?: Density;
  font_scale?: FontScale;
}

/** Defesa em profundidade: só confia na resposta se couber na allowlist. */
export function isMyPreferences(value: unknown): value is MyPreferences {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isDensity(candidate.density) &&
    isFontScale(candidate.font_scale) &&
    typeof candidate.version === "number" &&
    Number.isSafeInteger(candidate.version)
  );
}

/** `GET /api/v1/me/preferences` — qualquer perfil autenticado, só o próprio. */
export async function getMyPreferences(): Promise<MyPreferences> {
  const data = await apiClient.get<unknown>("/v1/me/preferences");
  if (!isMyPreferences(data)) throw new Error("Resposta de preferências inválida.");
  return data;
}

/** `PATCH /api/v1/me/preferences` — 409 em conflito de versão. */
export async function updateMyPreferences(payload: MyPreferencesUpdate): Promise<MyPreferences> {
  const data = await apiClient.patch<unknown>("/v1/me/preferences", payload);
  if (!isMyPreferences(data)) throw new Error("Resposta de preferências inválida.");
  return data;
}
