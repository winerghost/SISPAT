"use client";

import Link from "next/link";
import { FileText } from "lucide-react";

import { DashboardLayoutButton } from "./dashboard-layout-dialog";
import { EquipmentPanels } from "./equipment-panels";

// =============================================================================
// Composição cliente do /dashboard: a grade é governada SOMENTE pelo catálogo de
// painéis do backend (`useDashboardPanelPrefs`: ordem, visibilidade e tamanho
// P/M/G, via "Personalizar painéis"). Os filtros (família, unidade, categoria)
// ficam dentro da própria grade e vão para `/dashboard/panels/<id>/data`.
// =============================================================================

export function DashboardView() {
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <EquipmentPanels />
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

/** "Imprimir relatório" (/dashboard/relatorio). */
export function DashboardReportLink() {
  return (
    <Link
      href="/dashboard/relatorio"
      data-dashboard-report-link
      className="inline-flex h-10 items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
    >
      <FileText className="h-4 w-4" aria-hidden />
      Imprimir relatório
    </Link>
  );
}
