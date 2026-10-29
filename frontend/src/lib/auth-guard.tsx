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
//
// Links de convite/recuperação que caem na RAIZ (Site URL do Supabase) são
// desviados para `/ativar-conta` (`activation-redirect.ts`), lendo QUERY e HASH
// (`?token_hash=`, `?code=`, `?error=`, `#access_token=`). Enquanto o desvio
// está pendente, o conteúdo protegido NÃO é renderizado.
//
// Correção F6: sessão de RECUPERAÇÃO DE SENHA (`PASSWORD_RECOVERY`) nunca
// libera o sistema — mesmo que o desvio acima falhe, o guard bloqueia e manda
// para `/ativar-conta`, onde a senha é definida (`recovery-session.ts`).
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { ACTIVATION_ROUTE, activationRedirectFor } from "@/lib/activation-redirect";
import { UNAUTHORIZED_EVENT } from "@/lib/api-client";
import { useIsRecoverySession } from "@/lib/recovery-session";
import { signOutEverywhere, useSupabaseSession } from "@/lib/session";
import { clearUiCookie } from "@/lib/ui-preferences";

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
  // F6: a sessão atual veio de um link de recuperação de senha?
  const recoverySession = useIsRecoverySession(session);
  // Raiz: `undefined` = ainda não conferiu a URL; `null` = nada a repassar.
  const [rootActivation, setRootActivation] = useState<string | null | undefined>(
    pathname === "/" ? undefined : null,
  );

  useEffect(() => {
    if (pathname !== "/") {
      setRootActivation(null);
      return;
    }
    const target = activationRedirectFor(window.location.search, window.location.hash);
    setRootActivation(target);
    if (target) router.replace(target);
  }, [pathname, router]);

  // Sessão de recuperação: só serve para definir a nova senha. Se o desvio da
  // raiz já está pendente (com a credencial do link), ele tem precedência.
  useEffect(() => {
    if (isPublic || !recoverySession || rootActivation) return;
    router.replace(ACTIVATION_ROUTE);
  }, [isPublic, recoverySession, rootActivation, router]);

  useEffect(() => {
    if (!isPublic && !loading && !session && rootActivation === null) {
      clearUiCookie(); // sessão expirou/encerrada em outra aba: não deixa a preferência para o próximo usuário
      router.replace("/login");
    }
  }, [isPublic, loading, session, router, rootActivation]);

  useEffect(() => {
    if (isPublic) return;
    function handleUnauthorized() {
      void signOutEverywhere(queryClient).finally(() => router.replace("/login"));
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [isPublic, queryClient, router]);

  if (isPublic) return <>{children}</>;

  if (loading || !session || rootActivation !== null || recoverySession) {
    return (
      <div className="p-8 text-body-sm text-warm-granite" role="status" aria-live="polite">
        Verificando sessão…
      </div>
    );
  }

  return <>{children}</>;
}
