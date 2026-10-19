import Link from "next/link";
import { FileText } from "lucide-react";

import { DashboardPanels } from "@/components/features/dashboard/dashboard-panels";

// =============================================================================
// /dashboard — indicadores patrimoniais (todos os perfis). Os números vêm do
// backend (escopo por perfil/unidade decidido lá); nada é estimado aqui.
// =============================================================================

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-signal-orange" aria-hidden />
            <span className="text-eyebrow text-pale-stone">Painel patrimonial</span>
          </div>
          <h1 className="text-heading text-bone">Dashboard</h1>
          <p className="max-w-page text-body text-warm-granite">
            Indicadores do patrimônio nas unidades visíveis para o seu perfil.
          </p>
        </div>
        <Link
          href="/dashboard/relatorio"
          className="inline-flex h-10 items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
        >
          <FileText className="h-4 w-4" aria-hidden />
          Relatório imprimível
        </Link>
      </header>

      <DashboardPanels />
    </div>
  );
}
