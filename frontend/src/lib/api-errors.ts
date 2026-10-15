// =============================================================================
// SISPAT-AGU — api-errors.ts
// =============================================================================
// Mensagens GENÉRICAS e centralizadas para 403 e 429 (auditoria F-10). Nunca
// usa `ApiError.message`/`body` vindos do backend — só o status e, no 429, o
// `Retry-After` (já normalizado para segundos em `ApiError.retryAfterSeconds`).
// Autorização continua sendo do backend; isto é só texto de UX.
// =============================================================================

import { ApiError } from "@/lib/api-client";

export const FORBIDDEN_GENERIC_MESSAGE = "Você não tem permissão para esta ação.";

/** "alguns instantes" / "N segundos" / "N minutos" a partir do Retry-After. */
export function formatRetryAfter(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "alguns instantes";
  if (seconds < 60) return seconds === 1 ? "1 segundo" : `${seconds} segundos`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "1 hora" : `${hours} horas`;
}

export function rateLimitMessage(error: ApiError): string {
  const wait = error.retryAfterSeconds === undefined ? "alguns minutos" : formatRetryAfter(error.retryAfterSeconds);
  return `Muitas solicitações em pouco tempo. Aguarde ${wait} e tente de novo.`;
}

/** Mensagem para 403/429; `undefined` para os demais (a tela decide). */
export function throttleOrForbiddenMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 403) return FORBIDDEN_GENERIC_MESSAGE;
  if (error.status === 429) return rateLimitMessage(error);
  return undefined;
}
