import { Suspense } from "react";

import { DashboardHeaderActions, DashboardView } from "@/components/features/dashboard/dashboard-view";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

// =============================================================================
// /dashboard — indicadores patrimoniais (todos os perfis). Os números vêm do
// backend (escopo por perfil/unidade decidido lá); nada é estimado aqui.
// Filtros na URL (link compartilhável); "Imprimir relatório" leva os mesmos
// filtros; "Personalizar painéis" salva quais painéis aparecem e a ordem. As partes que leem a URL ficam em <Suspense> (useSearchParams).
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
        <Suspense fallback={null}>
          <DashboardHeaderActions />
        </Suspense>
      </header>

      <Suspense fallback={<LoadingSkeleton variant="cards" count={4} label="Carregando dashboard" />}>
        <DashboardView />
      </Suspense>
    </div>
  );
}
