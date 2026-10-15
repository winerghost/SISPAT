import type { ReactNode } from "react";

import { AguLogo } from "@/components/brand/agu-logo";

// =============================================================================
// Layout público — /login e /ativar-conta (tela autônoma, SEM shell do app).
// =============================================================================
// Sem Sidebar, Header do app nem AuthGuard (as rotas públicas não exigem
// sessão; o redirecionamento de rotas protegidas é do (app)/layout.tsx, então
// não há loop). Estrutura: cabeçalho de marca (banner) → <main id="conteudo">
// → rodapé (contentinfo), no viewport inteiro (min-h-dvh) sobre #101010.
// Só tokens do DESIGN.md: sem sombras/blur; eyebrow em Geist Mono 12px.
// Cadastro só por convite (CLAUDE.md): sem "Cadastre-se"/"Esqueceu a senha?".
// =============================================================================

export default function PublicLayout({ children }: { children: ReactNode }) {
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-dvh w-full flex-col bg-obsidian-canvas">
      {/* Marca centralizada (logo sobre painel claro + nome do sistema). */}
      <header className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-3 px-4 pt-4 sm:px-8 sm:pt-8">
        <AguLogo />
        <span className="text-eyebrow text-pale-stone">SISPAT-AGU</span>
      </header>

      <main id="conteudo" tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none [&>[data-animated-page]]:flex [&>[data-animated-page]]:flex-1 [&>[data-animated-page]]:flex-col">
        {children}
      </main>

      <footer className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 p-4 sm:px-8 sm:pb-8">
        <p className="text-body-sm text-warm-granite">Sistema de Gestão Patrimonial — AGU, Palmas/TO</p>
        <p className="text-body-sm text-warm-granite">
          Acesso apenas por convite. Em caso de dúvida, contate o administrador da sua unidade.
        </p>
        <p className="text-eyebrow text-pale-stone">© {year} AGU</p>
      </footer>
    </div>
  );
}
