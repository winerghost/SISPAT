"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { dashboardFiltersQueryString, parseDashboardFilters, type DashboardFilters } from "@/lib/dashboard-api";

// =============================================================================
// Filtros LEGADOS da URL, lidos apenas pelo relatório imprimível
// (/dashboard/relatorio). O dashboard em si não tem mais barra de filtros: seus
// painéis usam os filtros próprios do catálogo (família, unidade, categoria).
// Parse defensivo: chave desconhecida, repetida ou valor inválido é DESCARTADO.
// =============================================================================

export function hrefWithFilters(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}

/** Só leitura (relatório e link "Imprimir relatório"). */
export function useAppliedDashboardFilters(): { filters: DashboardFilters; query: string } {
  const searchParams = useSearchParams();
  const raw = searchParams.toString();
  return useMemo(() => {
    const filters = parseDashboardFilters(new URLSearchParams(raw));
    return { filters, query: dashboardFiltersQueryString(filters) };
  }, [raw]);
}
