"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { FadeIn } from "@/components/animations";
import { chartClasses, type ChartThemeName } from "@/components/dashboard/chart-theme";
import { StatCard } from "@/components/dashboard/stat-card";
import type { DashboardStat } from "@/components/dashboard/types";
import { useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  MONTHS_DEFAULT,
  NO_DASHBOARD_FILTERS,
  countDashboardFilters,
  useDashboardByBond,
  useDashboardByRoom,
  useDashboardBySituation,
  useDashboardByUnit,
  useDashboardInventory,
  useDashboardMonthlyAcquisitions,
  useDashboardPending,
  useDashboardSummary,
  useDashboardUnitLocation,
  type DashboardFilters,
  type DashboardSummary,
  type InventoryStatus,
  type LabeledCount,
  type RegistrationPending,
  type UnitBreakdownRow,
} from "@/lib/dashboard-api";
import type { DashboardChartPanel, DashboardPanelId } from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

import { ChartFilterShortcuts, type ShortcutGroup } from "./chart-filter-shortcuts";
import { ChartFocusProvider, useChartFocus } from "./chart-focus-context";
import { ChartTypeMenu } from "./chart-type-menu";
import {
  bondFilter,
  isPatchApplied,
  locationSeriesFilter,
  mergePatches,
  roomFilter,
  situationFilter,
  unitFilter,
  type FilterPatch,
  type UnitRefLike,
} from "./dashboard-chart-filters";
import { Block, CountCards, chartPlaceholder, formatInt, type PanelCtx } from "./dashboard-block";
import {
  TechAgeBlock,
  TechCategoryBlock,
  TechNoOwnerBlock,
  TechStatusBlock,
  TechSummaryBlock,
  TechUnitsBlock,
} from "./dashboard-tech-panels";
import { panelSpans, visiblePanels } from "./dashboard-panel-meta";
import { useDashboardChartPrefs, type DashboardChartPrefs } from "./use-dashboard-chart-prefs";
import { useDashboardLayoutPrefs } from "./use-dashboard-layout-prefs";
import {
  LOCATION_SERIES,
  buildLabeledData,
  buildMonthlyData,
  buildRoomData,
  buildSituationData,
  buildUnitLocationData,
  buildUnitModel,
  seriesValue,
  type UnitModel,
} from "./dashboard-transform";

// =============================================================================
// Blocos patrimoniais LEGADOS (15 painéis antigos). Desde a Onda 3 a tela
// /dashboard NÃO os usa: ela é governada só pelo catálogo de painéis
// (equipment-panels.tsx + use-dashboard-panel-prefs.ts). Este módulo é consumido
// apenas pelo relatório imprimível (/dashboard/relatorio, tema "paper"), que
// ainda compõe os blocos antigos; os ramos interativos (tema "screen":
// seletor de tipo, clique-para-filtrar, exportação de Tecnologia) ficam sem
// uso até o relatório migrar para o contrato novo de painéis.
// =============================================================================
// - Dados SEMPRE do backend via src/lib/dashboard-api.ts; nada é estimado.
// - Cada bloco tem skeleton, erro com "Tentar novamente" e estado vazio
//   honesto, de forma independente (uma consulta que falha não derruba as
//   outras).
// - Gráficos Nivo só são baixados no cliente (next/dynamic, ssr:false — o
//   Responsive* mede o DOM), um chunk por módulo: barras (@nivo/bar),
//   pizza/rosca (@nivo/pie) e linhas/áreas (@nivo/line).
// - `theme="paper"`: relatório (figura clara); cores e tema Nivo em chart-theme.ts.
// - `filters`: filtros da URL (DashboardFilters), repassados a TODAS as
//   consultas; com filtro ativo, o estado vazio diz que nada casou com eles.
// - Tipo de gráfico (`dashboard_charts`): unidades, situação, mensal,
//   localização por unidade, vínculo e sala. Painéis visíveis e ordem
//   (`dashboard_layout`): os mesmos na tela e no relatório; só o que o backend
//   confirmou é exibido. Painel oculto não é montado (nem consulta o backend).
// - `onFilter` (só na tela): clicar numa barra/fatia aplica o filtro
//   equivalente na URL (unidade, localizado, vínculo, sala). Alternativa por
//   teclado: botões da legenda (situação/vínculo) e "Filtrar pelo gráfico"
//   (unidade, localização, sala). Item sem filtro equivalente não tem ação.
// - Painéis de Tecnologia (ids tech_*): ver dashboard-tech-panels.tsx; recebem
//   os filtros comuns + classificação (categoria, tipo de TI, situação).
// - O "Detalhamento por unidade" (tabela) não é personalizável: fica sempre no fim.
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

// ---------------------------------------------------------------------------
// Contexto comum dos painéis
// ---------------------------------------------------------------------------

const PREFS_LOADING = (
  <div className="p-4 sm:p-5">{chartPlaceholder("Carregando preferências do gráfico")}</div>
);

/** Índice da categoria interna (`u3`, `r0`...) gerada nas transformações. */
const categoryIndex = (key: string) => Number.parseInt(key.slice(1), 10);

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
    {
      id: "nao-localizados",
      label: "Não localizados",
      value: summary.nao_localizados,
      description: `${formatInt(summary.desconhecidos)} com localização desconhecida`,
    },
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

function KpiBlock({ theme, filters, wide }: PanelCtx) {
  const query = useDashboardSummary(filters);
  return (
    <Block
      id="indicadores"
      title="Indicadores"
      query={query}
      theme={theme}
      isEmpty={() => false}
      emptyTitle=""
      emptyDescription=""
      skeleton={<LoadingSkeleton variant="cards" count={5} label="Carregando indicadores" />}
      wide={wide}
    >
      {(summary) => (
        <>
          <ul
            aria-label="Indicadores patrimoniais"
            className={cn(
              "m-0 grid list-none grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:p-5",
              wide ? "xl:grid-cols-5" : "xl:grid-cols-3",
            )}
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

const MULTI_BAR_CHARTS = {
  grouped: AnimatedGroupedBarChart,
  stacked: AnimatedStackedBarChart,
  horizontal: AnimatedHorizontalBarChart,
} as const;

function unitShortcutGroup(rows: readonly { unidade: string; unit_id?: string }[], units: PanelCtx["units"]): ShortcutGroup {
  return {
    label: "Unidade de uso",
    options: rows.flatMap((row, i) => {
      const patch = unitFilter(row, units);
      return patch ? [{ key: `u${i}`, label: row.unidade, patch }] : [];
    }),
  };
}

function UnitChartBlock({
  model,
  query,
  ...ctx
}: PanelCtx & { model: UnitModel | undefined; query: UseQueryResult<UnitBreakdownRow[], unknown> }) {
  const { theme, prefs, filtered, wide, onFilter, units, filters } = ctx;
  const title = "Bens por unidade";
  const Chart = MULTI_BAR_CHARTS[prefs.charts.units];
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
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "units", title, theme)}
    >
      {(rows) =>
        prefs.status === "loading" ? (
          PREFS_LOADING
        ) : (
          model && (
            <>
              <ChartSwap type={prefs.charts.units}>
                <Chart
                  title="Quantidade de bens por tipo em cada unidade"
                  data={model.chart}
                  valueFormatter={formatInt}
                  theme={theme}
                  className="border-0 p-4 sm:p-5"
                  onMarkClick={
                    onFilter
                      ? (categoryKey) => {
                          const row = rows[categoryIndex(categoryKey)];
                          const patch = row ? unitFilter(row, units) : null;
                          if (patch) onFilter(patch);
                        }
                      : undefined
                  }
                />
              </ChartSwap>
              {onFilter ? (
                <ChartFilterShortcuts
                  panelTitle={title}
                  groups={[unitShortcutGroup(rows, units)]}
                  filters={filters}
                  onFilter={onFilter}
                />
              ) : null}
            </>
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

function SituationBlock({ theme, prefs, filters, filtered, wide, onFilter }: PanelCtx) {
  const query = useDashboardBySituation(filters);
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
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "status", title, theme)}
    >
      {(slices) => {
        if (prefs.status === "loading") return PREFS_LOADING;
        const selected = slices.find((s) => isPatchApplied(filters, situationFilter(s.id)))?.id ?? null;
        return (
          <ChartSwap type={prefs.charts.status}>
            <Chart
              kind={prefs.charts.status}
              title="Distribuição por situação"
              data={buildSituationData(slices)}
              valueLabel="Bens"
              selectedKey={selected}
              onSelectKey={
                onFilter
                  ? (key) => {
                      const target = key ?? selected;
                      const patch = target ? situationFilter(target) : null;
                      if (patch) onFilter(patch);
                    }
                  : undefined
              }
              isSelectableKey={(key) => situationFilter(key) !== null}
              selectActionLabel="Filtrar por situação:"
              theme={theme}
              className="border-0 p-4 sm:p-5"
            />
          </ChartSwap>
        );
      }}
    </Block>
  );
}

function MonthlyBlock({ theme, prefs, filters, filtered, wide }: PanelCtx) {
  const query = useDashboardMonthlyAcquisitions(MONTHS_DEFAULT, filters);
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
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "monthly", title, theme)}
    >
      {(series) =>
        prefs.status === "loading" ? (
          PREFS_LOADING
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

function UnitLocationBlock({ theme, prefs, filters, filtered, wide, onFilter, units }: PanelCtx) {
  const query = useDashboardUnitLocation(filters);
  const title = "Localizados × não localizados por unidade";
  const Chart = MULTI_BAR_CHARTS[prefs.charts.location];
  return (
    <Block
      id="localizacao-por-unidade"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(rows) => rows.length === 0 || rows.every((r) => r.total === 0)}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil. Nenhum gráfico de exemplo é exibido."
      skeleton={chartPlaceholder("Carregando localização por unidade")}
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "location", title, theme)}
    >
      {(rows) =>
        prefs.status === "loading" ? (
          PREFS_LOADING
        ) : (
          <>
            <ChartSwap type={prefs.charts.location}>
              <Chart
                title="Situação de localização em cada unidade de uso"
                description="Unidade de uso do bem; até 15 unidades, o restante somado em “Outras”."
                data={buildUnitLocationData(rows)}
                valueFormatter={formatInt}
                theme={theme}
                className="border-0 p-4 sm:p-5"
                onMarkClick={
                  onFilter
                    ? (categoryKey, seriesKey) => {
                        const row = rows[categoryIndex(categoryKey)];
                        const patch = mergePatches(row ? unitFilter(row, units) : null, locationSeriesFilter(seriesKey));
                        if (patch) onFilter(patch);
                      }
                    : undefined
                }
              />
            </ChartSwap>
            {onFilter ? (
              <ChartFilterShortcuts
                panelTitle={title}
                groups={[
                  unitShortcutGroup(rows, units),
                  {
                    label: "Localizado",
                    options: LOCATION_SERIES.flatMap((s) => {
                      const patch = locationSeriesFilter(s.key);
                      return patch ? [{ key: s.key, label: s.label, patch }] : [];
                    }),
                  },
                ]}
                filters={filters}
                onFilter={onFilter}
              />
            ) : null}
          </>
        )
      }
    </Block>
  );
}

function BondBlock({ theme, prefs, filters, filtered, wide, onFilter }: PanelCtx) {
  const query = useDashboardByBond(filters);
  const title = "Bens por vínculo";
  const type = prefs.charts.bond;
  const Chart = type === "bar" ? CategoryBarChart : PieChart;
  return (
    <Block
      id="por-vinculo"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(items) => items.every((item) => item.value === 0)}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando bens por vínculo")}
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "bond", title, theme)}
    >
      {(items) => {
        if (prefs.status === "loading") return PREFS_LOADING;
        const selected = items.find((item) => isPatchApplied(filters, bondFilter(item.id)))?.id ?? null;
        return (
          <ChartSwap type={type}>
            <Chart
              kind={type}
              title="Quantidade de bens por vínculo"
              description="Vínculo informado na planilha (até 8; o restante em “Outros”)."
              data={buildLabeledData(items)}
              valueLabel="Bens"
              valueFormatter={formatInt}
              selectedKey={selected}
              onSelectKey={
                onFilter
                  ? (key) => {
                      const target = key ?? selected;
                      const patch = target ? bondFilter(target) : null;
                      if (patch) onFilter(patch);
                    }
                  : undefined
              }
              isSelectableKey={(key) => bondFilter(key) !== null}
              selectActionLabel="Filtrar por vínculo:"
              theme={theme}
              className="border-0 p-4 sm:p-5"
            />
          </ChartSwap>
        );
      }}
    </Block>
  );
}

function roomRows(items: LabeledCount[]): LabeledCount[] {
  return items.filter((item) => item.value > 0); // mesma regra de buildRoomData (índices r0, r1...)
}

function RoomBlock({ theme, prefs, filters, filtered, wide, onFilter }: PanelCtx) {
  const query = useDashboardByRoom(filters);
  const title = "Bens por sala";
  const type = prefs.charts.rooms;
  const Chart = type === "bar" ? AnimatedGroupedBarChart : AnimatedHorizontalBarChart;
  return (
    <Block
      id="por-sala"
      title={title}
      query={query}
      theme={theme}
      isEmpty={(items) => items.every((item) => item.value === 0)}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando bens por sala")}
      wide={wide}
      filtered={filtered}
      {...panelControls(prefs, "rooms", title, theme)}
    >
      {(items) => {
        if (prefs.status === "loading") return PREFS_LOADING;
        const rows = roomRows(items);
        return (
          <>
            <ChartSwap type={type}>
              <Chart
                title="Quantidade de bens por sala"
                description="Até 15 salas; o restante em “Outras” e os bens sem sala à parte."
                data={buildRoomData(items)}
                valueFormatter={formatInt}
                kindLabel={type === "bar" ? "Gráfico de barras verticais" : undefined}
                theme={theme}
                className="border-0 p-4 sm:p-5"
                onMarkClick={
                  onFilter
                    ? (categoryKey) => {
                        const item = rows[categoryIndex(categoryKey)];
                        const patch = item ? roomFilter(item.id) : null;
                        if (patch) onFilter(patch);
                      }
                    : undefined
                }
              />
            </ChartSwap>
            {onFilter ? (
              <ChartFilterShortcuts
                panelTitle={title}
                groups={[
                  {
                    label: "Sala",
                    options: rows.flatMap((item, i) => {
                      const patch = roomFilter(item.id);
                      return patch ? [{ key: `r${i}`, label: item.label, patch }] : [];
                    }),
                  },
                ]}
                filters={filters}
                onFilter={onFilter}
              />
            ) : null}
          </>
        );
      }}
    </Block>
  );
}

function pendingStats(data: RegistrationPending): DashboardStat[] {
  return [
    { id: "sem-responsavel", label: "Sem responsável", value: data.sem_responsavel },
    { id: "sem-sala", label: "Sem sala", value: data.sem_sala },
    { id: "ociosos", label: "Ociosos", value: data.ociosos, description: "Vínculo “Ocioso”" },
    { id: "pendencia-nao-localizados", label: "Não localizados", value: data.nao_localizados },
  ];
}

function inventoryStats(data: InventoryStatus): DashboardStat[] {
  return [
    { id: "conferidos", label: "Conferidos", value: data.conferidos, description: "Com conferência em inventário" },
    { id: "nao-conferidos", label: "Não conferidos", value: data.nao_conferidos, description: "Sem nenhuma conferência" },
    { id: "encontrados", label: "Encontrados", value: data.encontrados, description: "Na conferência mais recente" },
    {
      id: "nao-encontrados",
      label: "Não encontrados",
      value: data.nao_encontrados,
      description: "Na conferência mais recente",
    },
  ];
}

function PendingBlock({ theme, filters, wide }: PanelCtx) {
  const query = useDashboardPending(filters);
  return (
    <Block
      id="pendencias-cadastro"
      title="Pendências de cadastro"
      query={query}
      theme={theme}
      isEmpty={() => false}
      emptyTitle=""
      emptyDescription=""
      skeleton={<LoadingSkeleton variant="cards" count={4} label="Carregando pendências de cadastro" />}
      wide={wide}
    >
      {(data) => (
        <>
          <CountCards label="Pendências de cadastro" stats={pendingStats(data)} theme={theme} />
          <p className={cn("px-4 pb-4 text-body-sm sm:px-5", chartClasses(theme).legendValue)}>
            Um mesmo bem pode aparecer em mais de uma pendência.
          </p>
        </>
      )}
    </Block>
  );
}

function InventoryBlock({ theme, filters, wide }: PanelCtx) {
  const query = useDashboardInventory(filters);
  return (
    <Block
      id="inventario"
      title="Inventário"
      query={query}
      theme={theme}
      isEmpty={() => false}
      emptyTitle=""
      emptyDescription=""
      skeleton={<LoadingSkeleton variant="cards" count={4} label="Carregando inventário" />}
      wide={wide}
    >
      {(data) => <CountCards label="Situação no inventário" stats={inventoryStats(data)} theme={theme} />}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Composição (ordem e visibilidade confirmadas pelo backend)
// ---------------------------------------------------------------------------

interface DashboardPanelsProps {
  theme?: ChartThemeName;
  className?: string;
  /** Filtros da URL (já validados no parse); vão para todas as consultas. */
  filters?: DashboardFilters;
  /** Clique num gráfico → filtro da URL (só na tela; o relatório não recebe). */
  onFilter?: (patch: FilterPatch) => void;
}

export function DashboardPanels(props: DashboardPanelsProps) {
  return (
    <ChartFocusProvider>
      <PanelsGrid {...props} />
    </ChartFocusProvider>
  );
}

function PanelsGrid({ theme = "screen", className, filters = NO_DASHBOARD_FILTERS, onFilter: onFilterProp }: DashboardPanelsProps) {
  const focus = useChartFocus();
  const onFilter = useCallback(
    (patch: FilterPatch) => {
      focus?.remember();
      onFilterProp?.(patch);
    },
    [focus, onFilterProp],
  );
  const interactive = theme === "screen" && !!onFilterProp;
  const layoutPrefs = useDashboardLayoutPrefs();
  const chartPrefs = useDashboardChartPrefs();
  const unitQuery = useDashboardByUnit(filters);
  const model = useMemo(() => (unitQuery.data ? buildUnitModel(unitQuery.data) : undefined), [unitQuery.data]);
  // Mesma consulta (e cache) do seletor "Unidade de uso": sigla → id no clique.
  const access = useLookupAccess();
  const accessibleUnits = useAccessibleUnits(access.ready && interactive);
  const filtered = countDashboardFilters(filters) > 0;

  if (layoutPrefs.status === "loading") {
    return (
      <div data-dashboard-panels className={cn("flex flex-col gap-4", className)}>
        <LoadingSkeleton variant="cards" count={4} label="Carregando painéis do dashboard" />
      </div>
    );
  }

  const ids = visiblePanels(layoutPrefs.layout);
  const spans = panelSpans(ids);
  const ctxFor = (id: DashboardPanelId): PanelCtx => ({
    theme,
    filters,
    filtered,
    prefs: chartPrefs,
    wide: spans[id] ?? false,
    onFilter: interactive ? onFilter : undefined,
    units: accessibleUnits.data?.units,
  });

  const render = (id: DashboardPanelId): ReactNode => {
    const ctx = ctxFor(id);
    switch (id) {
      case "kpis":
        return <KpiBlock {...ctx} />;
      case "units":
        return <UnitChartBlock {...ctx} model={model} query={unitQuery} />;
      case "status":
        return <SituationBlock {...ctx} />;
      case "monthly":
        return <MonthlyBlock {...ctx} />;
      case "location":
        return <UnitLocationBlock {...ctx} />;
      case "bond":
        return <BondBlock {...ctx} />;
      case "pending":
        return <PendingBlock {...ctx} />;
      case "rooms":
        return <RoomBlock {...ctx} />;
      case "inventory":
        return <InventoryBlock {...ctx} />;
      case "tech_summary":
        return <TechSummaryBlock {...ctx} />;
      case "tech_category":
        return <TechCategoryBlock {...ctx} />;
      case "tech_units":
        return <TechUnitsBlock {...ctx} />;
      case "tech_status":
        return <TechStatusBlock {...ctx} />;
      case "tech_no_owner":
        return <TechNoOwnerBlock {...ctx} />;
      case "tech_age":
        return <TechAgeBlock {...ctx} />;
    }
  };

  return (
    <div
      data-dashboard-panels
      data-dashboard-order={ids.join(",")}
      className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6", className)}
    >
      {ids.map((id) => (
        <Fragment key={id}>{render(id)}</Fragment>
      ))}
      <Block
        id="detalhamento"
        title="Detalhamento por unidade"
        query={unitQuery}
        theme={theme}
        isEmpty={(rows) => rows.length === 0}
        emptyTitle="Nenhuma unidade com bens"
        emptyDescription="Não há unidades com bens para o seu perfil. Nenhum valor é exibido até que existam dados."
        skeleton={<LoadingSkeleton variant="table" count={4} columns={4} label="Carregando detalhamento por unidade" />}
        wide
        filtered={filtered}
      >
        {(rows) => model && <UnitTable rows={rows} model={model} theme={theme} />}
      </Block>
    </div>
  );
}
