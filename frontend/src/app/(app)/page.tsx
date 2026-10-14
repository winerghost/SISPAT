import { StaggerContainer, StaggerItem } from "@/components/animations";
import { DashboardOverview } from "@/components/dashboard";
import { Badge } from "@/components/ui/badge";

// =============================================================================
// Home / Dashboard — Fase 1.
// =============================================================================
// NÃO existem endpoints de indicadores: o painel recebe
// `status="unavailable"` e mostra um estado vazio honesto. Nenhum número de
// demonstração, nenhum skeleton sem consulta real, nenhum filtro falso.
// Quando o backend expuser indicadores, troque por um hook de dados (em
// src/lib) que alimente `DashboardOverview` com `status`/`data` reais.
//
// Movimento: a introdução entra em sequência (StaggerContainer — só em
// navegação client-side; a 1ª carga SSR já aparece pronta) e o frame usa a
// entrada nomeada sfDashboardFrameIn uma única vez.
// =============================================================================

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <StaggerContainer className="flex flex-col gap-8">
        <StaggerItem index={0} className="flex items-center gap-3">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-orange" aria-hidden />
          <span className="text-eyebrow text-pale-stone">Status do sistema</span>
        </StaggerItem>

        <StaggerItem index={1} className="flex flex-col gap-3">
          <h1 className="text-heading text-bone">SISPAT-AGU</h1>
          <p className="max-w-page text-body text-warm-granite">
            Sistema de Gestão Patrimonial da AGU — unidade Palmas/TO.
          </p>
        </StaggerItem>

        <StaggerItem
          index={2}
          className="flex max-w-lg flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding"
        >
          <div className="flex items-center gap-2">
            <Badge variant="warning">Fase 1 em andamento</Badge>
          </div>
          <p className="text-body-sm text-warm-granite">
            Banco de dados, modelagem e permissionamento estão em desenvolvimento no backend. Os
            módulos patrimoniais ainda não exibem dados reais.
          </p>
        </StaggerItem>
      </StaggerContainer>

      <DashboardOverview status="unavailable" />
    </div>
  );
}
