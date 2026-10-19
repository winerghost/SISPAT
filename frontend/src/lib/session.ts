"use client";

// =============================================================================
// SISPAT-AGU — session.ts
// =============================================================================
// Ponte entre a sessão do Supabase Auth (no navegador) e o contrato de
// identidade do backend (`GET /api/v1/me`). Dois hooks:
//
//   - useSupabaseSession(): sessão bruta do Supabase (token, usuário) +
//     estado de carregamento. Assina `onAuthStateChange` para refletir
//     login/logout/refresh de token em tempo real.
//   - useMe(): chama `GET /api/v1/me` com o access_token da sessão atual
//     como `Authorization: Bearer`, via TanStack Query. É a fonte de
//     verdade para papéis, permissões e o nível de autenticação atual
//     (`current_aal`) — usado para decidir se a área administrativa pode
//     ser liberada (precisa de `current_aal === 'aal2'` quando
//     `mfa_required` for `true`).
//
// `apiClient` (ver `@/lib/api-client`) anexa o header Authorization
// automaticamente (após conferir a origem da API); `getAuthHeaders()` é mantido
// para chamadas explícitas (o header explícito tem precedência e é idêntico).
//
// IMPORTANTE: nada aqui é mecanismo de segurança — `useMe()`/
// `isAdministrativeAreaUnlocked()` só decidem UX. A autorização (RBAC, AAL2,
// escopo por unidade) é sempre revalidada pelo backend Flask.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";

import { apiClient, ApiError } from "@/lib/api-client";
import { clearPersistedAuthState, getSupabaseClient } from "@/lib/supabase-client";
import { clearUiCookie } from "@/lib/ui-preferences";

export type AuthenticatorAssuranceLevel = "aal1" | "aal2";

export interface MeResponse {
  id: string;
  name: string;
  email: string;
  roles: string[];
  permissions: string[];
  current_aal: AuthenticatorAssuranceLevel;
  mfa_required: boolean;
  /**
   * Se o usuário tem foto de perfil (UA-FE-01). Opcional por compatibilidade
   * com backends antigos: `undefined` é tratado como `false`.
   */
  has_avatar?: boolean;
}

/** Chave do cache de `/me`: só o id do usuário (`sub`), nunca o token. */
export function meQueryKey(userId: string | null): readonly ["me", string | null] {
  return ["me", userId];
}

/** Monta o header Authorization a partir da sessão Supabase atual, se houver. */
export async function getAuthHeaders(): Promise<HeadersInit> {
  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `GET /api/v1/me` — identidade, papéis, permissões e AAL da sessão atual. */
export async function fetchMe(): Promise<MeResponse> {
  const headers = await getAuthHeaders();
  return apiClient.get<MeResponse>("/v1/me", { headers });
}

/**
 * Sessão bruta do Supabase Auth no navegador. `loading` fica `true` até a
 * primeira resolução (inclui o tempo que o SDK leva para processar um
 * eventual token na URL — ver `/ativar-conta`).
 */
export function useSupabaseSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

/**
 * `GET /api/v1/me` reativo à sessão Supabase. Desabilitado enquanto não há
 * sessão (evita uma chamada 401 previsível a cada carregamento de página
 * pública como `/login`).
 */
export function useMe(): UseQueryResult<MeResponse, ApiError> {
  const { session, loading } = useSupabaseSession();
  const queryClient = useQueryClient();
  const userId = session?.user?.id ?? null;

  // Sem sessão: descarta o cache de `/me` (identidade/permissões do usuário
  // anterior não podem sobreviver ao logout).
  useEffect(() => {
    if (!loading && !session) queryClient.removeQueries({ queryKey: ["me"] });
  }, [loading, session, queryClient]);

  return useQuery<MeResponse, ApiError>({
    // Chave estável por usuário (F-3): NUNCA o JWT (mudaria a cada refresh e
    // deixaria o token no cache/devtools). `fetchMe` lê o token atual.
    queryKey: meQueryKey(userId),
    queryFn: fetchMe,
    enabled: !loading && !!session,
    retry: false,
    staleTime: 15_000,
  });
}

/**
 * Helper imperativo (fora de componente React) usado no fluxo de
 * login/MFA: confirma se a sessão atual já está em `aal2` quando o backend
 * exige MFA, re-chamando `/me` após o desafio ser verificado.
 */
export function isAdministrativeAreaUnlocked(me: MeResponse | undefined): boolean {
  if (!me) return false;
  if (!me.mfa_required) return true;
  return me.current_aal === "aal2";
}

/**
 * Encerra a sessão de forma completa (logout):
 *   1. `signOut({ scope: "global" })` revoga TODOS os refresh tokens do
 *      usuário no Supabase Auth (todas as sessões/dispositivos);
 *   2. se a revogação remota falhar (rede/token já expirado), ainda assim
 *      encerra localmente (`scope: "local"`) — o logout nunca "falha aberto";
 *   3. remove resíduos de sessão do storage do navegador;
 *   4. apaga o cookie `sispat-ui` (Max-Age=0);
 *   5. limpa o cache do TanStack Query (dados de `/me`, usuários, prévias).
 */
export async function signOutEverywhere(queryClient?: QueryClient): Promise<void> {
  const supabase = (() => {
    try {
      return getSupabaseClient();
    } catch {
      return null;
    }
  })();
  if (supabase) {
    try {
      const { error } = await supabase.auth.signOut({ scope: "global" });
      if (error) await supabase.auth.signOut({ scope: "local" });
    } catch {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        /* segue para a limpeza local */
      }
    }
  }
  clearPersistedAuthState();
  // Cookie de aparência (`sispat-ui`): apagado no logout e no 401 global
  // (AuthGuard também passa por aqui).
  clearUiCookie();
  queryClient?.clear();
}

/** Hook para um botão "Sair": logout completo + redirecionamento para /login. */
export const useSignOut = () => {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await signOutEverywhere(queryClient);
    window.location.replace("/login");
  }, [queryClient]);
};
