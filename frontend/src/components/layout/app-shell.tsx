"use client";

import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AuthGuard } from "@/lib/auth-guard";
import { useSupabaseSession } from "@/lib/session";
import { useMyPreferences } from "@/lib/use-my-preferences";

// =============================================================================
// AppShell — Sidebar/Header só existem com sessão Supabase (auditoria F-6).
// Sem sessão (carregando ou deslogado) renderiza apenas o <main> com o
// AuthGuard ("Verificando sessão…" / redirecionamento para /login), sem o chrome
// do app. Só UX: a autorização é sempre do backend.
// =============================================================================

/**
 * Sincroniza a aparência (cookie `sispat-ui` + atributos no <html>) com o que o
 * backend guarda, assim que há sessão. Falha silenciosa: o sistema segue com o
 * cookie/padrões.
 */
function UiPreferencesSync({ enabled }: { enabled: boolean }) {
  useMyPreferences({ enabled });
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { session, loading } = useSupabaseSession();
  const showChrome = !loading && !!session;

  return (
    <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
      <UiPreferencesSync enabled={showChrome} />
      {showChrome && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden print:block print:overflow-visible">
        {showChrome && <Header />}
        <main id="conteudo" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none print:overflow-visible">
          <AuthGuard>{children}</AuthGuard>
        </main>
      </div>
    </div>
  );
}
