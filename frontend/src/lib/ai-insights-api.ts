// =============================================================================
// SISPAT-AGU — ai-insights-api.ts
// =============================================================================
// Contrato da IA consultiva na Home (Etapa 4b):
//   GET  /api/v1/ai/insights -> {status, generated_at, items[{kind,title,text}]}
//   POST /api/v1/ai/ask      -> {status:"ok", answer, tools_used[]} | {status:"unavailable"}
// Só transporte + validação por allowlist/limites: resposta fora do formato é
// rejeitada. Todo texto é TEXTO PURO (o React escapa; sem markdown/HTML). Nada
// é persistido no navegador (pergunta/resposta só vivem em memória).
// `tools_used` NÃO é dado confiável: é informativo e opcional na UI.
// =============================================================================

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient } from "@/lib/api-client";

export const INSIGHT_KINDS = ["alert_priority", "executive_summary", "quality_suggestion"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export interface AiInsight {
  kind: InsightKind;
  title: string;
  text: string;
}

export type AiInsights =
  | { status: "unavailable"; generated_at: string | null; items: [] }
  | { status: "ok"; generated_at: string | null; items: AiInsight[] };

export type AiAnswer =
  | { status: "unavailable" }
  | { status: "ok"; answer: string; tools_used: string[] };

export const AI_QUESTION_MAX = 500;
const MAX_ITEMS = 30;
const MAX_TITLE = 200;
const MAX_TEXT = 8000;
const MAX_ANSWER = 8000;
const MAX_TOOLS = 10;
const TOOL_PATTERN = /^[a-z0-9_.-]{1,64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInsightKind(value: unknown): value is InsightKind {
  return typeof value === "string" && (INSIGHT_KINDS as readonly string[]).includes(value);
}

export function isAiInsight(value: unknown): value is AiInsight {
  if (!isRecord(value)) return false;
  return (
    isInsightKind(value.kind) &&
    typeof value.title === "string" &&
    value.title.length <= MAX_TITLE &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= MAX_TEXT
  );
}

export function isAiInsights(value: unknown): value is AiInsights {
  if (!isRecord(value)) return false;
  const generatedOk =
    value.generated_at === null ||
    (typeof value.generated_at === "string" && value.generated_at.length > 0 && value.generated_at.length <= 64);
  if (!generatedOk) return false;
  if (value.status === "unavailable") return true;
  return (
    value.status === "ok" &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_ITEMS &&
    value.items.every(isAiInsight)
  );
}

export function isAiAnswer(value: unknown): value is AiAnswer {
  if (!isRecord(value)) return false;
  if (value.status === "unavailable") return true;
  return (
    value.status === "ok" &&
    typeof value.answer === "string" &&
    value.answer.length > 0 &&
    value.answer.length <= MAX_ANSWER &&
    Array.isArray(value.tools_used) &&
    value.tools_used.length <= MAX_TOOLS &&
    value.tools_used.every((tool) => typeof tool === "string" && TOOL_PATTERN.test(tool))
  );
}

/** `GET /api/v1/ai/insights` — só lê o cache do backend; nunca dispara a IA. */
export async function getAiInsights(): Promise<AiInsights> {
  const data = await apiClient.get<unknown>("/v1/ai/insights");
  if (!isAiInsights(data)) throw new Error("Resposta de insights inválida.");
  // Normaliza: unavailable nunca carrega itens.
  return data.status === "unavailable" ? { status: "unavailable", generated_at: data.generated_at, items: [] } : data;
}

/** `POST /api/v1/ai/ask` — a pergunta é enviada e descartada; nada é guardado. */
export async function askAi(question: string): Promise<AiAnswer> {
  const data = await apiClient.post<unknown>("/v1/ai/ask", { question });
  if (!isAiAnswer(data)) throw new Error("Resposta da IA inválida.");
  return data;
}

export const AI_INSIGHTS_QUERY_KEY = ["ai", "insights"] as const;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

export function useAiInsights(): UseQueryResult<AiInsights, unknown> {
  return useQuery({
    queryKey: AI_INSIGHTS_QUERY_KEY,
    queryFn: getAiInsights,
    retry: shouldRetry,
    staleTime: 60_000,
  });
}

export function useAskAi(): UseMutationResult<AiAnswer, unknown, string> {
  // Sem retry automático e sem cache de resposta além do estado do componente.
  return useMutation({ mutationFn: askAi, retry: false, gcTime: 0 });
}

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isRateLimitedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}
