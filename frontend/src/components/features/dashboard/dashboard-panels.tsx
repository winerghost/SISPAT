"use client";

import { useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { FadeIn } from "@/components/animations";
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
import type { DashboardChartPanel } from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

import { ChartTypeMenu } from "./chart-type-menu";
import { useDashboardChartPrefs, type DashboardChartPrefs } from "./use-dashboard-chart-prefs";
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
// - Gráficos Nivo só são baixados no cliente (next/dynamic, ssr:false — o
//   Responsive* mede o DOM), um chunk por módulo: barras (@nivo/bar),
//   pizza/rosca (@nivo/pie) e linhas/áreas (@nivo/line). O módulo de pizza
//   não é baixado se o usuário escolheu "Barras" na situação, etc.
// - `theme="paper"`: relatório (figura clara); cores e tema Nivo em chart-theme.ts.
// =============================================================================

const chartLoading = () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" />;

const PieChart = dynamic(() => import("@/components/dashboard/nivo-pie-chart").then((m) => m.PieChart), {
  ssr: false,
  loading: chartLoading,
});
const CategoryBarChart = dynamic(() => import("@/components/dashboard/nivo-bar-charts").then((m) => m.CategoryBarChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedGroupedBarChart = dynamic(() => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedGroupedBarChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedStackedBarChart = dynamic(() => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedStackedBarChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedHorizontalBarChart = dynamic(() => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedHorizontalBarChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedLineChart = dynamic(() => import("@/components/dashboard/nivo-line-charts").then((m) => m.AnimatedLineChart), {
  ssr: false,
  loading: chartLoading,
});
const AnimatedAreaChart = dynamic(() => import("@/components/dashboard/nivo-line-charts").then((m) => m.AnimatedAreaChart), {
  ssr: false,
  loading: chartLoading,
});

// ---------------------------------------------------------------------------
// Seletor do tipo de gráfico (tema "screen"; no relatório impresso não há controles)
// ---------------------------------------------------------------------------

function PanelNotice({ prefs, panel }: { prefs: DashboardChartPrefs; panel: DashboardChartPanel }) {
  if (prefs.savingPanel === panel) {
    return (
      <p role="status" data-chart-saving className="px-4 pt-2 text-caption text-warm-granite sm:px-5">
        Salvando tipo de gráfico…
      </p>
    );
  }
  if (prefs.notice?.panel === panel) {
    return (
      <p role="alert" data-chart-notice={prefs.notice.kind} className="px-4 pt-2 text-body-sm text-bone sm:px-5">
        {prefs.notice.text}
      </p>
    );
  }
  return null;
}

function panelControls<P extends DashboardChartPanel>(
  prefs: DashboardChartPrefs,
  panel: P,
  panelTitle: string,
  theme: ChartThemeName,
): { controls: ReactNode; notice: ReactNode } {
  if (theme === "paper" || prefs.status !== "ready") return { controls: null, notice: null };
  return {
    controls: (
      <ChartTypeMenu
        panel={panel}
        panelTitle={panelTitle}
        value={prefs.charts[panel]}
        busy={prefs.busy}
        saving={prefs.savingPanel === panel}
        onSelect={(value) => prefs.select(panel, value)}
        onRestore={() => prefs.restore(panel)}
      />
    ),
    notice: <PanelNotice prefs={prefs} panel={panel} />,
  };
}

/** Troca de tipo com entrada por opacidade (200 ms; sem movimento sob reduced motion). */
function ChartSwap({ type, children }: { type: string; children: ReactNode }) {
  return (
    <FadeIn key={type} data-chart-type={type} className="min-w-0">
      {children}
    </FadeIn>
  );
}

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
  /** Seletor de tipo de gráfico (só aparece quando há dados para exibir). */
  controls?: ReactNode;
  /** Estado do salvamento / erro do seletor. */
  notice?: ReactNode;
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
  controls,
  notice,
  children,
}: BlockProps<T>) {
  const cls = chartClasses(theme);
  const headingId = `dash-${id}`;
  const showControls = !query.isPending && !query.isError && !isEmpty(query.data as T);
  return (
    <section
      aria-labelledby={headingId}
      data-dashboard-block={id}
      className={cn("flex min-w-0 flex-col rounded-cards border print:break-inside-avoid", cls.figure, className)}
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

const UNIT_CHARTS = {
  grouped: AnimatedGroupedBarChart,
  stacked: AnimatedStackedBarChart,
  horizontal: AnimatedHorizontalBarChart,
} as const;

function chartPlaceholder(label: string) {
  return <LoadingSkeleton variant="cards" count={1} label={label} />;
}

function UnitChartBlock({
  theme,
  model,
  query,
  prefs,
}: {
  theme: ChartThemeName;
  model: UnitModel | undefined;
  query: UseQueryResult<UnitBreakdownRow[], unknown>;
  prefs: DashboardChartPrefs;
}) {
  const title = "Bens por unidade";
  const Chart = UNIT_CHARTS[prefs.charts.units];
  return (
    <Block
      id="por-unidade"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(rows) => rows.length === 0 || rows.every((r) => r.total === 0)}
      emptyTitle="Nenhum bem cadastrado"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil. Nenhum gráfico de exemplo é exibido."
      skeleton={chartPlaceholder("Carregando bens por unidade")}
      className="lg:col-span-2"
      {...panelControls(prefs, "units", title, theme)}
    >
      {() =>
        prefs.status === "loading" ? (
          <div className="p-4 sm:p-5">{chartPlaceholder("Carregando preferências do gráfico")}</div>
        ) : (
          model && (
            <ChartSwap type={prefs.charts.units}>
              <Chart
                title="Quantidade de bens por tipo em cada unidade"
                data={model.chart}
                valueFormatter={formatInt}
                theme={theme}
                className="border-0 p-4 sm:p-5"
              />
            </ChartSwap>
          )
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

function SituationBlock({ theme, prefs }: { theme: ChartThemeName; prefs: DashboardChartPrefs }) {
  const query = useDashboardBySituation();
  const [selected, setSelected] = useState<string | null>(null);
  const title = "Bens por situação";
  const Chart = prefs.charts.status === "bar" ? CategoryBarChart : PieChart;
  return (
    <Block
      id="por-situacao"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(slices) => slices.every((s) => s.value === 0)}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Ainda não há bens com situação registrada nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando bens por situação")}
      {...panelControls(prefs, "status", title, theme)}
    >
      {(slices) =>
        prefs.status === "loading" ? (
          <div className="p-4 sm:p-5">{chartPlaceholder("Carregando preferências do gráfico")}</div>
        ) : (
          <ChartSwap type={prefs.charts.status}>
            <Chart
              kind={prefs.charts.status}
              title="Distribuição por situação"
              data={buildSituationData(slices)}
              valueLabel="Bens"
              selectedKey={selected}
              onSelectKey={setSelected}
              theme={theme}
              className="border-0 p-4 sm:p-5"
            />
          </ChartSwap>
        )
      }
    </Block>
  );
}

function MonthlyBlock({ theme, prefs }: { theme: ChartThemeName; prefs: DashboardChartPrefs }) {
  const query = useDashboardMonthlyAcquisitions();
  const title = "Aquisições mensais";
  const type = prefs.charts.monthly;
  const Chart = type === "line" ? AnimatedLineChart : type === "area" ? AnimatedAreaChart : AnimatedGroupedBarChart;
  return (
    <Block
      id="aquisicoes-mensais"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(series) => series.every((s) => s.data.length === 0)}
      emptyTitle="Nenhuma aquisição no período"
      emptyDescription="Não há aquisições registradas nos últimos meses para as unidades visíveis ao seu perfil."
      skeleton={chartPlaceholder("Carregando aquisições mensais")}
      {...panelControls(prefs, "monthly", title, theme)}
    >
      {(series) =>
        prefs.status === "loading" ? (
          <div className="p-4 sm:p-5">{chartPlaceholder("Carregando preferências do gráfico")}</div>
        ) : (
          <ChartSwap type={type}>
            <Chart
              title="Bens adquiridos por mês"
              data={buildMonthlyData(series)}
              valueFormatter={formatInt}
              kindLabel={type === "bar" ? "Gráfico de barras" : undefined}
              theme={theme}
              className="border-0 p-4 sm:p-5"
            />
          </ChartSwap>
        )
      }
    </Block>
  );
}

export function DashboardPanels({ theme = "screen", className }: { theme?: ChartThemeName; className?: string }) {
  const unitQuery = useDashboardByUnit();
  const model = useMemo(() => (unitQuery.data ? buildUnitModel(unitQuery.data) : undefined), [unitQuery.data]);
  const chartPrefs = useDashboardChartPrefs();

  return (
    <div data-dashboard-panels className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6", className)}>
      <KpiBlock theme={theme} />
      <UnitChartBlock theme={theme} model={model} query={unitQuery} prefs={chartPrefs} />
      <SituationBlock theme={theme} prefs={chartPrefs} />
      <MonthlyBlock theme={theme} prefs={chartPrefs} />
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
