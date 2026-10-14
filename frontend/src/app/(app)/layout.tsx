import type { ReactNode } from "react";

import { AuthGuard } from "@/lib/auth-guard";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

// =============================================================================
// Shell autenticado — rotas do app: /, /configuracoes/*, /administracao/*.
// Sidebar + Header + <main id="conteudo"> + AuthGuard (sem sessão → /login).
// Telas públicas (/login, /ativar-conta) usam (publico)/layout.tsx: sem menu.
// =============================================================================

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Header />
          <main id="conteudo" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none">
            <AuthGuard>{children}</AuthGuard>
          </main>
        </div>
      </div>
      <Toaster />
    </>
  );
}
