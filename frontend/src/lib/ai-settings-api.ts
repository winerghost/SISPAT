// =============================================================================
// SISPAT-AGU — ai-settings-api.ts
// =============================================================================
// Tipos e chamadas de `/api/v1/settings/ai` (contrato em
// docs/architecture/modulo-configuracoes.md, Etapa 1). Só transporte: toda
// regra (allowlist de modelos, limites, aceite DeepSeek, AAL2, permissão
// `settings.ai.manage`) é validada pelo backend Flask.
//
// As chaves de API NUNCA trafegam por aqui: o backend devolve apenas
// "configured" | "not_configured" por provedor.
//
// Caminhos começam em `/v1/...` porque `NEXT_PUBLIC_API_URL` já inclui `/api`
// (ver `users-api.ts`). O Authorization é anexado pelo `apiClient`.
// =============================================================================

import { apiClient } from "@/lib/api-client";

export type AiStatus = "active" | "disabled" | "unavailable";
export type AiProvider = "none" | "openai" | "anthropic" | "deepseek";
/** Provedores reais (com chave/modelos); `none` não tem chave nem modelos. */
export type AiKeyedProvider = Exclude<AiProvider, "none">;
export type AiKeyState = "configured" | "not_configured";

export type AiFeatureKey = "alerts_explain" | "executive_summary" | "assistant" | "data_quality";
export type AiFeatures = Record<AiFeatureKey, boolean>;

export interface AiSettings {
  status: AiStatus;
  env_enabled: boolean;
  enabled: boolean;
  provider: AiProvider;
  model: string | null;
  features: AiFeatures;
  monthly_token_cap: number;
  deepseek_acknowledged: boolean;
  keys: Record<AiKeyedProvider, AiKeyState>;
  models: Record<AiKeyedProvider, string[]>;
  version: number;
  updated_at: string;
}

/** Corpo do PATCH (`extra="forbid"` no backend): só estes campos; `version` obrigatório. */
export interface AiSettingsUpdate {
  version: number;
  enabled?: boolean;
  provider?: AiProvider;
  model?: string;
  features?: Partial<AiFeatures>;
  monthly_token_cap?: number;
  acknowledge_international_transfer?: true;
}

export type AiTestResult = "ok" | "disabled" | "not_configured" | "unavailable";

export interface AiTestResponse {
  result: AiTestResult;
  latency_ms?: number | null;
}

export const AI_PROVIDERS: readonly AiKeyedProvider[] = ["openai", "anthropic", "deepseek"];
export const AI_FEATURE_KEYS: readonly AiFeatureKey[] = [
  "alerts_explain",
  "executive_summary",
  "assistant",
  "data_quality",
];
/** Limite superior aceito pelo backend (só para o atributo `max` do input). */
export const AI_MONTHLY_TOKEN_CAP_MAX = 50_000_000;

/** `GET /api/v1/settings/ai` — ADM + AAL2 + `settings.ai.manage`. */
export function getAiSettings(): Promise<AiSettings> {
  return apiClient.get<AiSettings>("/v1/settings/ai");
}

/** `PATCH /api/v1/settings/ai` — devolve o estado novo com `version` incrementado. */
export function updateAiSettings(payload: AiSettingsUpdate): Promise<AiSettings> {
  return apiClient.patch<AiSettings>("/v1/settings/ai", payload);
}

/** `POST /api/v1/settings/ai/test` — prompt fixo sem dados do sistema; sempre 200. */
export function testAiConnection(): Promise<AiTestResponse> {
  return apiClient.post<AiTestResponse>("/v1/settings/ai/test");
}
