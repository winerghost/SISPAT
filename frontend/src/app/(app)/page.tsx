import { StaggerContainer, StaggerItem } from "@/components/animations";
import { AiInsightsWidget, AskSispatBox } from "@/components/features/dashboard/ai-insights-widget";
import { AlertsWidget } from "@/components/features/dashboard/alerts-widget";
import { DashboardShortcut } from "@/components/features/dashboard/dashboard-shortcut";

// =============================================================================
// Home — introdução, alertas, insights de IA e atalho para o Dashboard.
// =============================================================================
// Os indicadores e gráficos reais (GET /dashboard/resumo e correlatos) vivem
// em /dashboard (DashboardView). A Home NÃO repete números: oferece apenas o
// atalho, sem dado de demonstração nem estado "indisponível" falso.
//
// Movimento: a introdução entra em sequência (StaggerContainer — só em
// navegação client-side; a 1ª carga SSR já aparece pronta).
// =============================================================================

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <StaggerContainer className="flex flex-col gap-8">
        <StaggerItem index={0} className="flex items-center gap-3">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-orange" aria-hidden />
          <span className="text-eyebrow text-pale-stone">Início</span>
        </StaggerItem>

        <StaggerItem index={1} className="flex flex-col gap-3">
          <h1 className="text-heading text-bone">SISPAT-AGU</h1>
          <p className="max-w-page text-body text-warm-granite">
            Sistema de Gestão Patrimonial da AGU — unidade Palmas/TO.
          </p>
        </StaggerItem>

        <StaggerItem index={2} className="flex">
          <DashboardShortcut />
        </StaggerItem>
      </StaggerContainer>

      <AlertsWidget />

      <AiInsightsWidget />
      <AskSispatBox />
    </div>
  );
}
