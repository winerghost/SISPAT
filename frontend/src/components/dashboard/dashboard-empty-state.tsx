import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";

import { cn } from "@/lib/utils";

// =============================================================================
// Estado vazio HONESTO do dashboard: diz por que não há números e não simula
// nada (sem zeros, sem gráficos de exemplo, sem skeleton sem consulta real).
// =============================================================================

export interface DashboardEmptyStateProps {
  title?: string;
  description?: ReactNode;
  /** Ação real opcional (ex.: link para uma tela existente). */
  action?: ReactNode;
  className?: string;
}

export function DashboardEmptyState({
  title = "Indicadores ainda indisponíveis",
  description = "Os indicadores patrimoniais aparecerão aqui quando o módulo patrimonial estiver ativo no backend. Nenhum número é exibido até lá — este painel não usa dados de demonstração.",
  action,
  className,
}: DashboardEmptyStateProps) {
  return (
    <div
      data-dashboard-empty
      className={cn("flex flex-col items-start gap-3 px-5 py-10 sm:px-8 sm:py-14", className)}
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-buttons border border-ash-stroke text-warm-granite">
        <BarChart3 className="h-4 w-4" aria-hidden />
      </span>
      <h3 className="text-body text-bone">{title}</h3>
      <p className="max-w-xl text-body-sm text-warm-granite">{description}</p>
      {action}
    </div>
  );
}
