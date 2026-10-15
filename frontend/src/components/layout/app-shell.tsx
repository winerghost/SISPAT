"use client";

import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AuthGuard } from "@/lib/auth-guard";
import { useSupabaseSession } from "@/lib/session";

// =============================================================================
// AppShell — Sidebar/Header só existem com sessão Supabase (auditoria F-6).
// Sem sessão (carregando ou deslogado) renderiza apenas o <main> com o
// AuthGuard ("Verificando sessão…" / redirecionamento para /login), sem o chrome
// do app. Só UX: a autorização é sempre do backend.
// =============================================================================

export function AppShell({ children }: { children: ReactNode }) {
  const { session, loading } = useSupabaseSession();
  const showChrome = !loading && !!session;

  return (
    <div className="flex h-screen overflow-hidden">
      {showChrome && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {showChrome && <Header />}
        <main id="conteudo" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none">
          <AuthGuard>{children}</AuthGuard>
        </main>
      </div>
    </div>
  );
}
