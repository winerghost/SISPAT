import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cookies } from "next/headers";

import { QueryProvider } from "@/lib/query-client";
import { MotionProvider } from "@/components/animations/motion-provider";
import { parseUiCookie, UI_COOKIE_NAME } from "@/lib/ui-preferences";

import "./globals.css";

// =============================================================================
// Layout raiz — SISPAT-AGU
// =============================================================================
// Só o "casco" (html/body, fontes, providers, skip link). O shell (Sidebar +
// Header + AuthGuard + Toaster) vive em (app)/layout.tsx; a tela autônoma de
// /login e /ativar-conta, em (publico)/layout.tsx. Os route groups não
// alteram as URLs.
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Aparência sem flash: cookie NÃO sensível `sispat-ui` (`density.font_scale`),
  // parse estrito com allowlist — inválido/ausente → padrões. O backend segue
  // sendo a fonte de verdade (ver src/lib/ui-preferences.ts).
  const cookieStore = await cookies();
  const ui = parseUiCookie(cookieStore.get(UI_COOKIE_NAME)?.value);

  return (
    <html
      lang="pt-BR"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      data-density={ui.density}
      data-font-scale={ui.font_scale}
    >
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
          {children}
          </MotionProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
