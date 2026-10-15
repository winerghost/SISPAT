import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/app-shell";

// =============================================================================
// Shell autenticado — rotas do app: /, /configuracoes/*, /administracao/*.
// AppShell: Sidebar + Header (só com sessão) + <main id="conteudo"> + AuthGuard
// (sem sessão → /login). Telas públicas (/login, /ativar-conta) usam
// (publico)/layout.tsx: sem menu.
// =============================================================================

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppShell>{children}</AppShell>
      <Toaster />
    </>
  );
}
