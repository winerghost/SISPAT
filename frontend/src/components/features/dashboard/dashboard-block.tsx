"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { chartClasses, type ChartThemeName } from "@/components/dashboard/chart-theme";
import { StatCard } from "@/components/dashboard/stat-card";
import type { DashboardStat } from "@/components/dashboard/types";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import type { DashboardFilters } from "@/lib/dashboard-api";
import { cn } from "@/lib/utils";

import { useChartFocus } from "./chart-focus-context";
import type { FilterPatch, UnitRefLike } from "./dashboard-chart-filters";
import type { DashboardChartPrefs } from "./use-dashboard-chart-prefs";

// =============================================================================
// Peças comuns dos painéis do dashboard (extraídas de dashboard-panels.tsx):
// bloco com skeleton / erro com "Tentar novamente" / estado vazio honesto,
// contexto dos painéis e grade de cartões de contagem. Nenhum número é
// estimado: tudo vem do backend.
// =============================================================================

const nf = new Intl.NumberFormat("pt-BR");
export const formatInt = (n: number) => nf.format(n);

// ---------------------------------------------------------------------------
// Bloco com estados
// ---------------------------------------------------------------------------

export interface BlockProps<T> {
  id: string;
  title: string;
  query: UseQueryResult<T, unknown>;
  theme: ChartThemeName;
  isEmpty: (data: T) => boolean;
  emptyTitle: string;
  emptyDescription: string;
  skeleton?: ReactNode;
  /** Ocupa as 2 colunas da grade (lg+). */
  wide?: boolean;
  /** Seletor de tipo de gráfico (só aparece quando há dados para exibir). */
  controls?: ReactNode;
  /** Estado do salvamento / erro do seletor. */
  notice?: ReactNode;
  /** Há filtro ativo: o estado vazio explica que nada casou com os filtros. */
  filtered?: boolean;
  children: (data: T) => ReactNode;
}

const FILTERED_EMPTY_TITLE = "Nenhum bem com estes filtros";
const FILTERED_EMPTY_DESCRIPTION =
  "Nenhum bem visível para o seu perfil corresponde aos filtros ativos. Ajuste ou limpe os filtros.";

export function Block<T>({
  id,
  title,
  query,
  theme,
  isEmpty,
  emptyTitle,
  emptyDescription,
  skeleton,
  wide = false,
  controls,
  notice,
  filtered = false,
  children,
}: BlockProps<T>) {
  const cls = chartClasses(theme);
  const headingId = `dash-${id}`;
  const showControls = !query.isPending && !query.isError && !isEmpty(query.data as T);
  // Depois de filtrar pelo gráfico, o foco volta ao botão usado (ver chart-focus-context).
  const sectionRef = useRef<HTMLElement>(null);
  const focus = useChartFocus();
  const ready = !query.isPending && !query.isError;
  useEffect(() => {
    if (ready) focus?.restore(id, sectionRef.current);
  }, [ready, query.data, focus, id]);
  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      data-dashboard-block={id}
      className={cn(
        "flex min-w-0 flex-col rounded-cards border print:break-inside-avoid",
        cls.figure,
        wide && "lg:col-span-2",
      )}
    >
      <div className="flex items-start justify-between gap-2 px-4 pt-4 sm:px-5">
        <h2 id={headingId} className={cn("min-w-0 pt-1 text-eyebrow", cls.legendLabel)}>
          {title}
        </h2>
        {showControls ? controls : null}
      </div>
      {showControls ? notice : null}
      {query.isPending ? (
        <div className="p-4 sm:p-5">
          {skeleton ?? <LoadingSkeleton variant="lines" count={4} label={`Carregando ${title}`} />}
        </div>
      ) : query.isError ? (
        <div role="alert" data-dashboard-error className="flex flex-col items-start gap-3 p-4 sm:p-5">
          <p className={cn("flex items-start gap-2 text-body-sm", cls.legendLabel)}>
            <AlertTriangle
              className={cn("mt-0.5 h-4 w-4 shrink-0", theme === "paper" ? "text-graphite-mid" : "text-signal-orange")}
              aria-hidden="true"
            />
            Não foi possível carregar este bloco. Nenhum valor foi estimado.
          </p>
          <Button
            variant={theme === "paper" ? "outlineOnLight" : "ghost"}
            size="sm"
            className="print:hidden"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            <RefreshCw aria-hidden="true" />
            Tentar novamente
          </Button>
        </div>
      ) : isEmpty(query.data) ? (
        <div data-dashboard-empty className="flex flex-col items-start gap-2 p-4 sm:p-5">
          <span
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-buttons border",
              cls.figure,
              cls.legendValue,
            )}
          >
            <BarChart3 className="h-4 w-4" aria-hidden />
          </span>
          <p className={cn("text-body", cls.legendLabel)}>{filtered ? FILTERED_EMPTY_TITLE : emptyTitle}</p>
          <p className={cn("max-w-xl text-body-sm", cls.legendValue)}>
            {filtered ? FILTERED_EMPTY_DESCRIPTION : emptyDescription}
          </p>
        </div>
      ) : (
        children(query.data)
      )}
    </section>
  );
}


export interface PanelCtx {
  theme: ChartThemeName;
  filters: DashboardFilters;
  filtered: boolean;
  prefs: DashboardChartPrefs;
  /** Ocupa 2 colunas (calculado pela ordem escolhida). */
  wide: boolean;
  /** Clique/teclado → filtro da URL (ausente no relatório). */
  onFilter?: (patch: FilterPatch) => void;
  /** Unidades acessíveis (sigla → id para o clique no gráfico de unidades). */
  units?: readonly UnitRefLike[];
}

export function chartPlaceholder(label: string) {
  return <LoadingSkeleton variant="cards" count={1} label={label} />;
}


/** Grade de cartões com números do backend (sem gráfico). */
export function CountCards({ label, stats, theme }: { label: string; stats: DashboardStat[]; theme: ChartThemeName }) {
  return (
    <ul aria-label={label} className="m-0 grid list-none grid-cols-2 gap-3 p-4 sm:p-5">
      {stats.map((stat) => (
        <li key={stat.id} className="min-w-0">
          <StatCard stat={stat} theme={theme} className="h-full rounded-cards p-3 sm:p-5" />
        </li>
      ))}
    </ul>
  );
}

