"use client";

import Link from "next/link";
import { FileText } from "lucide-react";

import { DashboardFilterBar, DashboardFilterSummary } from "./dashboard-filter-bar";
import { DashboardLayoutButton } from "./dashboard-layout-dialog";
import { DashboardPanels } from "./dashboard-panels";
import { hrefWithFilters, useAppliedDashboardFilters, useDashboardUrlFilters } from "./use-dashboard-url-filters";

// =============================================================================
// Composição cliente do /dashboard: barra de filtros (estado na URL), resumo
// dos filtros aplicados e painéis (clique num gráfico → filtro na URL). Usa
// `useSearchParams` → a página a envolve em <Suspense>.
// =============================================================================

export function DashboardView() {
  const state = useDashboardUrlFilters();
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <DashboardFilterBar state={state} />
      <DashboardFilterSummary filters={state.applied} />
      <DashboardPanels filters={state.applied} onFilter={state.toggle} />
    </div>
  );
}

/** Ações do cabeçalho: personalizar painéis + imprimir relatório. */
export function DashboardHeaderActions() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DashboardLayoutButton />
      <DashboardReportLink />
    </div>
  );
}

/** "Imprimir relatório" preservando os filtros aplicados (os da URL). */
export function DashboardReportLink() {
  const { query } = useAppliedDashboardFilters();
  return (
    <Link
      href={hrefWithFilters("/dashboard/relatorio", query)}
      data-dashboard-report-link
      className="inline-flex h-10 items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
    >
      <FileText className="h-4 w-4" aria-hidden />
      Imprimir relatório
    </Link>
  );
}
