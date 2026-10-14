"use client";

// =============================================================================
// SISPAT-AGU — auth-guard.tsx
// =============================================================================
// Guarda de rotas NO CLIENTE (somente UX — nunca mecanismo de segurança; a
// autorização real é do backend Flask, ver CLAUDE.md > Arquitetura).
//
//   - Rotas públicas (`PUBLIC_ROUTES`): renderizadas sempre.
//   - Demais rotas: sem sessão Supabase → `router.replace("/login")`, sem
//     renderizar o conteúdo protegido.
//   - Evento `sispat:unauthorized` (401 do backend, emitido por `apiClient`):
//     logout local completo + redirecionamento para /login.
//
// Por que não no middleware: a sessão do supabase-js fica no storage do
// navegador (não em cookie), invisível ao servidor. Ver plano de migração
// para cookies (`@supabase/ssr`) no relatório de segurança do frontend.
//
// O redirecionamento é SEMPRE para o caminho fixo "/login" — nunca para um
// destino vindo da URL (`?next=`/`?redirect=`), evitando open redirect.
// =============================================================================

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { UNAUTHORIZED_EVENT } from "@/lib/api-client";
import { signOutEverywhere, useSupabaseSession } from "@/lib/session";

/** Rotas acessíveis sem sessão (não existe /register nem /signup — só convite). */
export const PUBLIC_ROUTES = ["/login", "/ativar-conta"] as const;

export function isPublicRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isPublic = isPublicRoute(pathname);
  const { session, loading } = useSupabaseSession();

  useEffect(() => {
    if (!isPublic && !loading && !session) {
      router.replace("/login");
    }
  }, [isPublic, loading, session, router]);

  useEffect(() => {
    if (isPublic) return;
    function handleUnauthorized() {
      void signOutEverywhere(queryClient).finally(() => router.replace("/login"));
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [isPublic, queryClient, router]);

  if (isPublic) return <>{children}</>;

  if (loading || !session) {
    return (
      <div className="p-8 text-body-sm text-warm-granite" role="status" aria-live="polite">
        Verificando sessão…
      </div>
    );
  }

  return <>{children}</>;
}
