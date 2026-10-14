import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import { QueryProvider } from "@/lib/query-client";
import { AuthGuard } from "@/lib/auth-guard";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MotionProvider } from "@/components/animations/motion-provider";

import "./globals.css";

// =============================================================================
// Layout raiz — SISPAT-AGU
// =============================================================================
// Tema: DESIGN.md (Factory) é dark-only — não existe variante clara
// documentada ("Full-bleed #101010 canvas at all times — no light body
// background", "Keep the canvas #101010 on every section"). Por isso o tema
// escuro é aplicado incondicionalmente em <html>, sem toggle de usuário.
//
// Fontes: GeistSans/GeistMono vêm do pacote oficial "geist" (next/font,
// self-hosted, sem chamada externa em runtime) e expõem as variáveis CSS
// --font-geist-sans/--font-geist-mono consumidas por tailwind.config.ts.
// =============================================================================

// Segurança: força renderização dinâmica para que o Next aplique o nonce da
// CSP (gerado por requisição em src/middleware.ts) aos seus <script>.
// Páginas pré-renderizadas estaticamente sairiam sem nonce e seriam
// bloqueadas pela CSP. Ver docs/security/evidence/frontend-security.md.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SISPAT-AGU",
  description: "Sistema de Gestão Patrimonial da AGU — unidade Palmas/TO.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${GeistSans.variable} ${GeistMono.variable}`} data-theme="dark">
      <body className="bg-obsidian-canvas text-bone antialiased">
        {/* WCAG 2.4.1 (Bypass Blocks): primeiro alvo de Tab, visível só no foco. */}
        <a
          href="#conteudo"
          className="sr-only rounded-buttons bg-chalk text-body-sm text-obsidian-canvas focus:not-sr-only focus:px-[14px] focus:py-2 focus:fixed focus:left-4 focus:top-4 focus:z-[60]"
        >
          Pular para o conteúdo
        </a>
        <QueryProvider>
          {/* Motion: LazyMotion(domAnimation) + reducedMotion="user" — ver motion-provider.tsx. */}
          <MotionProvider>
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
          </MotionProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
