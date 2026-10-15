"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError } from "@/lib/api-client";
import { getMyPreferences, type MyPreferences } from "@/lib/preferences-api";
import { persistUiPreferences } from "@/lib/ui-preferences";

// =============================================================================
// Hook das preferências de aparência do usuário. Só depois de o backend
// responder com sucesso grava o cookie `sispat-ui` e aplica os atributos no
// <html> (nada de aplicar estado não confirmado). O backend é a fonte de
// verdade: se o cookie divergir, a resposta dele vence.
// =============================================================================

export const MY_PREFERENCES_QUERY_KEY = ["me", "preferences"] as const;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

async function fetchAndPersist(): Promise<MyPreferences> {
  const prefs = await getMyPreferences();
  persistUiPreferences(prefs);
  return prefs;
}

export function useMyPreferences(options: { enabled?: boolean } = {}): UseQueryResult<MyPreferences, unknown> {
  return useQuery({
    queryKey: MY_PREFERENCES_QUERY_KEY,
    queryFn: fetchAndPersist,
    retry: shouldRetry,
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}
