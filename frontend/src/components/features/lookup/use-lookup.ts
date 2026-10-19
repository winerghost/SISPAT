"use client";

import { useQuery } from "@tanstack/react-query";

import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { ApiError, listAccessibleUnits } from "@/lib/catalog-api";
import { useMe } from "@/lib/session";

// =============================================================================
// Hooks das telas de consulta. Leitura para TODOS os perfis; o backend aplica
// perfil, AAL2 (ADM) e escopo de unidade. `isAdmin` só decide se aparece o link
// para o cadastro (UX).
// =============================================================================

export function useLookupAccess() {
  const me = useMe();
  return {
    me,
    /** Dados só são pedidos depois que `/me` confirma a sessão. */
    ready: me.isSuccess,
    sessionError: me.isError,
    isAdmin: !!me.data?.roles.includes(ADMIN_ROLE),
  };
}

export const noClientRetry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

/** `GET /api/v1/units/accessible` — unidades do escopo do usuário (todos os perfis). */
export function useAccessibleUnits(enabled: boolean) {
  return useQuery({
    queryKey: ["lookup", "units", "accessible"],
    queryFn: listAccessibleUnits,
    enabled,
    staleTime: 60_000,
    retry: noClientRetry,
  });
}
