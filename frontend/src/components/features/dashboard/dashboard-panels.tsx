"use client";

import { useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { chartClasses, type ChartThemeName } from "@/components/dashboard/chart-theme";
import { StatCard } from "@/components/dashboard/stat-card";
import type { DashboardStat } from "@/components/dashboard/types";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  useDashboardBySituation,
  useDashboardByUnit,
  useDashboardMonthlyAcquisitions,
  useDashboardSummary,
  type DashboardSummary,
  type UnitBreakdownRow,
} from "@/lib/dashboard-api";
import { cn } from "@/lib/utils";

import {
  buildMonthlyData,
  buildSituationData,
  buildUnitModel,
  seriesValue,
  type UnitModel,
} from "./dashboard-transform";

// =============================================================================
// Painel de indicadores patrimoniais (tela /dashboard e relatório imprimível).
// =============================================================================
// - Dados SEMPRE do backend via src/lib/dashboard-api.ts; nada é estimado.
// - Cada bloco tem skeleton, erro com "Tentar novamente" e estado vazio
//   honesto, de forma independente (uma consulta que falha não derruba as
//   outras).
// - Recharts (~170 kB) só é baixado no cliente (import dinâmico, ssr:false).
// - `theme="paper"`: relatório (figura clara); cores em chart-theme.ts.
// =============================================================================

const chartLoading = () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" />;

const AnimatedChart = dynamic(() => import("@/components/dashboard/animated-chart").then((m) => m.AnimatedChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedGroupedBarChart = dynamic(
  () => import("@/components/dashboard/animated-chart").then((m) => m.AnimatedGroupedBarChart),
  { ssr: false, loading: chartLoading },
);
const AnimatedLineChart = dynamic(
  () => import("@/components/dashboard/animated-chart").then((m) => m.AnimatedLineChart),
  { ssr: false, loading: chartLoading },
);

const nf = new Intl.NumberFormat("pt-BR");
const formatInt = (n: number) => nf.format(n);

// ---------------------------------------------------------------------------
// Bloco com estados
// ---------------------------------------------------------------------------

interface BlockProps<T> {
  id: string;
  title: string;
  query: UseQueryResult<T, unknown>;
  theme: ChartThemeName;
  isEmpty: (data: T) => boolean;
  emptyTitle: string;
  emptyDescription: string;
  skeleton?: ReactNode;
  className?: string;
  children: (data: T) => ReactNode;
}

function Block<T>({
  id,
  title,
  query,
  theme,
  isEmpty,
  emptyTitle,
  emptyDescription,
  skeleton,
  className,
  children,
}: BlockProps<T>) {
  const cls = chartClasses(theme);
  const headingId = `dash-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-dashboard-block={id}
      className={cn("flex min-w-0 flex-col rounded-cards border print:break-inside-avoid", cls.figure, className)}
    >
      <h2 id={headingId} className={cn("px-4 pt-4 text-eyebrow sm:px-5", cls.legendLabel)}>
        {title}
      </h2>
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
          <p className={cn("text-body", cls.legendLabel)}>{emptyTitle}</p>
          <p className={cn("max-w-xl text-body-sm", cls.legendValue)}>{emptyDescription}</p>
        </div>
      ) : (
        children(query.data)
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Indicadores (KPIs) + bloco "Indicadores indisponíveis"
// ---------------------------------------------------------------------------

function buildStats(summary: DashboardSummary): DashboardStat[] {
  return [
    {
      id: "total-bens",
      label: "Total de bens",
      value: summary.total_bens,
      delta: summary.variacao.total_bens,
      description: `${formatInt(summary.novos_30d)} novos nos últimos 30 dias`,
    },
    { id: "localizados", label: "Localizados", value: summary.localizados },
    { id: "movimentacoes-pendentes", label: "Movimentações pendentes", value: summary.movimentacoes_pendentes },
    { id: "inventarios-abertos", label: "Inventários abertos", value: summary.inventarios_abertos },
  ];
}

const UNAVAILABLE_INDICATORS = ["Valor total", "Em manutenção", "Baixas no ano"] as const;

function UnavailableIndicators({ theme }: { theme: ChartThemeName }) {
  const cls = chartClasses(theme);
  return (
    <aside
      aria-labelledby="dash-indisponiveis"
      data-dashboard-unavailable
      className={cn("flex flex-col gap-3 border-t px-4 py-4 sm:px-5", cls.figure)}
    >
      <h3 id="dash-indisponiveis" className={cn("text-eyebrow", cls.title)}>
        Indicadores indisponíveis
      </h3>
      <p className={cn("max-w-prose text-body-sm", cls.legendValue)}>
        O cadastro de bens ainda não possui valor, estado de manutenção nem registro de baixa. Por isso estes
        indicadores não são calculados — nenhum número é estimado.
      </p>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {UNAVAILABLE_INDICATORS.map((label) => (
          <div key={label} className="flex items-baseline gap-2">
            <dt className={cn("text-body-sm", cls.legendLabel)}>{label}</dt>
            <dd className={cn("text-body-sm", cls.legendValue)}>Indisponível</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function KpiBlock({ theme }: { theme: ChartThemeName }) {
  const query = useDashboardSummary();
  return (
    <Block
      id="indicadores"
      title="Indicadores"
      query={query}
      theme={theme}
      isEmpty={() => false}
      emptyTitle=""
      emptyDescription=""
      skeleton={<LoadingSkeleton variant="cards" count={4} label="Carregando indicadores" />}
      className="lg:col-span-2"
    >
      {(summary) => (
        <>
          <ul
            aria-label="Indicadores patrimoniais"
            className="m-0 grid list-none grid-cols-2 gap-3 p-4 sm:p-5 lg:grid-cols-4"
          >
            {buildStats(summary).map((stat) => (
              <li key={stat.id} className="min-w-0">
                <StatCard stat={stat} theme={theme} className="h-full rounded-cards p-3 sm:p-5" />
              </li>
            ))}
          </ul>
          <UnavailableIndicators theme={theme} />
        </>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Gráficos e tabela
// ---------------------------------------------------------------------------

function UnitChartBlock({
  theme,
  model,
  query,
}: {
  theme: ChartThemeName;
  model: UnitModel | undefined;
  query: UseQueryResult<UnitBreakdownRow[], unknown>;
}) {
  return (
    <Block
      id="por-unidade"
      title="Bens por unidade"
      query={query}
      theme={theme}
      isEmpty={(rows) => rows.length === 0 || rows.every((r) => r.total === 0)}
      emptyTitle="Nenhum bem cadastrado"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil. Nenhum gráfico de exemplo é exibido."
      skeleton={<LoadingSkeleton variant="cards" count={1} label="Carregando bens por unidade" />}
      className="lg:col-span-2"
    >
      {() =>
        model && (
          <AnimatedGroupedBarChart
            title="Quantidade de bens por tipo em cada unidade"
            data={model.chart}
            valueFormatter={formatInt}
            theme={theme}
            className="border-0 p-4 sm:p-5"
          />
        )
      }
    </Block>
  );
}

function UnitTable({ rows, model, theme }: { rows: UnitBreakdownRow[]; model: UnitModel; theme: ChartThemeName }) {
  const paper = theme === "paper";
  const headRight = cn("text-right", paper && "text-graphite-mid");
  const num = cn("text-right tabular-nums", paper && "text-obsidian-canvas");
  const rowCls = paper ? "border-graphite-mid/30 hover:bg-transparent" : undefined;
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  return (
    <div className="px-1 pb-2 sm:px-2">
      <Table regionLabel="Detalhamento de bens por unidade (rolável)">
        <caption className="sr-only">Detalhamento de bens por unidade e tipo</caption>
        <TableHeader className={paper ? "border-graphite-mid" : undefined}>
          <TableRow className={rowCls}>
            <TableHead scope="col" className={paper ? "text-graphite-mid" : undefined}>
              Unidade
            </TableHead>
            <TableHead scope="col" className={headRight}>
              Total
            </TableHead>
            {model.series.map((s) => (
              <TableHead key={s.key} scope="col" className={headRight}>
                {s.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={`${row.unidade}:${i}`} className={rowCls}>
              <th
                scope="row"
                className={cn(
                  "px-4 py-[var(--density-cell-y)] text-left align-middle font-regular break-words",
                  paper ? "text-obsidian-canvas" : "text-bone",
                )}
              >
                {row.unidade}
              </th>
              <TableCell className={num}>{formatInt(row.total)}</TableCell>
              {model.series.map((s) => (
                <TableCell key={s.key} className={num}>
                  {formatInt(seriesValue(row, s.key, model.head))}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        <TableFooter className={paper ? "border-graphite-mid bg-transparent" : undefined}>
          <TableRow className={rowCls} data-unit-total>
            <TableCell className={paper ? "text-obsidian-canvas" : undefined}>Total</TableCell>
            <TableCell className={num}>{formatInt(grandTotal)}</TableCell>
            {model.series.map((s) => (
              <TableCell key={s.key} className={num}>
                {formatInt(rows.reduce((sum, r) => sum + seriesValue(r, s.key, model.head), 0))}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function SituationBlock({ theme }: { theme: ChartThemeName }) {
  const query = useDashboardBySituation();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Block
      id="por-situacao"
      title="Bens por situação"
      query={query}
      theme={theme}
      isEmpty={(slices) => slices.every((s) => s.value === 0)}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Ainda não há bens com situação registrada nas unidades visíveis para o seu perfil."
      skeleton={<LoadingSkeleton variant="cards" count={1} label="Carregando bens por situação" />}
    >
      {(slices) => (
        <AnimatedChart
          kind="donut"
          title="Distribuição por situação"
          data={buildSituationData(slices)}
          valueLabel="Bens"
          selectedKey={selected}
          onSelectKey={setSelected}
          theme={theme}
          className="border-0 p-4 sm:p-5"
        />
      )}
    </Block>
  );
}

function MonthlyBlock({ theme }: { theme: ChartThemeName }) {
  const query = useDashboardMonthlyAcquisitions();
  return (
    <Block
      id="aquisicoes-mensais"
      title="Aquisições mensais"
      query={query}
      theme={theme}
      isEmpty={(series) => series.every((s) => s.data.length === 0)}
      emptyTitle="Nenhuma aquisição no período"
      emptyDescription="Não há aquisições registradas nos últimos meses para as unidades visíveis ao seu perfil."
      skeleton={<LoadingSkeleton variant="cards" count={1} label="Carregando aquisições mensais" />}
    >
      {(series) => (
        <AnimatedLineChart
          title="Bens adquiridos por mês"
          data={buildMonthlyData(series)}
          valueFormatter={formatInt}
          theme={theme}
          className="border-0 p-4 sm:p-5"
        />
      )}
    </Block>
  );
}

export function DashboardPanels({ theme = "screen", className }: { theme?: ChartThemeName; className?: string }) {
  const unitQuery = useDashboardByUnit();
  const model = useMemo(() => (unitQuery.data ? buildUnitModel(unitQuery.data) : undefined), [unitQuery.data]);

  return (
    <div data-dashboard-panels className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6", className)}>
      <KpiBlock theme={theme} />
      <UnitChartBlock theme={theme} model={model} query={unitQuery} />
      <SituationBlock theme={theme} />
      <MonthlyBlock theme={theme} />
      <Block
        id="detalhamento"
        title="Detalhamento por unidade"
        query={unitQuery}
        theme={theme}
        isEmpty={(rows) => rows.length === 0}
        emptyTitle="Nenhuma unidade com bens"
        emptyDescription="Não há unidades com bens para o seu perfil. Nenhum valor é exibido até que existam dados."
        skeleton={<LoadingSkeleton variant="table" count={4} columns={4} label="Carregando detalhamento por unidade" />}
        className="lg:col-span-2"
      >
        {(rows) => model && <UnitTable rows={rows} model={model} theme={theme} />}
      </Block>
    </div>
  );
}
