"use client";

import { ResponsiveBar, type BarDatum, type BarTooltipProps } from "@nivo/bar";

import {
  ChartShell,
  MAX_LABELED_MARKS,
  MAX_TICK_CHARS,
  OTHERS_KEY,
  TooltipBox,
  defaultFormatter,
  hasMarks,
  integerTicks,
  thinCategories,
  truncate,
  useCategoryModel,
  useSeriesModel,
  type AnimatedChartProps,
  type AnimatedSeriesChartProps,
} from "./chart-shell";
import { chartClasses, chartPalette, nivoTheme, withAlpha } from "./chart-theme";

// =============================================================================
// Barras (Nivo ResponsiveBar) no tema Factory.
// =============================================================================
// - Unidades: agrupadas | empilhadas | horizontais (várias séries).
// - Situação "Barras": série única neutra, categoria selecionada em destaque.
// - borderRadius 4; rótulos de valor fora da barra (topo/direita) quando
//   legíveis (≤ 16 marcas e barra larga o bastante); empilhadas mostram o
//   total da pilha (o rótulo dentro do segmento não tem contraste garantido).
// - Largura máxima de barra (~28 px/série, 40 px/pilha) por padding calculado
//   a partir da largura medida — barras não viram blocos em 1920 px.
// - animate={false}: sem mola (CLAUDE.md). A entrada é o FadeIn do painel.
// - Eixos com inteiros (sem casas decimais) e rótulos rarefeitos no celular.
// =============================================================================

type BarMode = "grouped" | "stacked" | "horizontal";

const BAR_MODE_LABEL: Record<BarMode, string> = {
  grouped: "Gráfico de barras agrupadas",
  stacked: "Gráfico de barras empilhadas",
  horizontal: "Gráfico de barras horizontais",
};

const INDEX_KEY = "__cat__";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Padding da banda para que o grupo de barras não passe de `group` px. */
function bandPadding(available: number, categories: number, group: number, min = 0.2): number {
  if (available <= 0 || categories <= 0) return 0.3;
  const band = available / categories;
  return clamp(1 - group / band, min, 0.85);
}

/** Altura que acompanha o número de categorias nas barras horizontais. */
function horizontalHeight(categories: number, series: number): number {
  const perCategory = series * 16 + 18;
  return Math.min(720, Math.max(240, categories * perCategory + 40));
}

/** Implementação comum: barras agrupadas, empilhadas ou horizontais. */
function BarSeriesChart({
  mode,
  title,
  description,
  data,
  valueFormatter = defaultFormatter,
  height,
  kindLabel,
  theme = "screen",
  className,
}: AnimatedSeriesChartProps & { mode: BarMode }) {
  const palette = chartPalette(theme);
  const cls = chartClasses(theme);
  const model = useSeriesModel(data, palette, valueFormatter);
  if (!hasMarks(data)) return null;

  const horizontal = mode === "horizontal";
  const stacked = mode === "stacked";
  const marks = data.categories.length * data.series.length;
  const labeled = !stacked && marks <= MAX_LABELED_MARKS;
  const chartHeight = height ?? (horizontal ? horizontalHeight(data.categories.length, data.series.length) : 280);

  const rows: BarDatum[] = data.categories.map((category) => {
    const row: BarDatum = { [INDEX_KEY]: category.key };
    for (const s of model.series) {
      const value = model.valueOf(s, category.key);
      if (value !== null && value >= 0) row[s.dataKey] = value;
    }
    return row;
  });
  // Nivo desenha a 1ª categoria horizontal embaixo; invertemos para ler de cima.
  const ordered = horizontal ? [...rows].reverse() : rows;

  const max = Math.max(
    0,
    ...rows.map((row) =>
      stacked
        ? model.series.reduce((sum, s) => sum + (typeof row[s.dataKey] === "number" ? (row[s.dataKey] as number) : 0), 0)
        : Math.max(0, ...model.series.map((s) => (typeof row[s.dataKey] === "number" ? (row[s.dataKey] as number) : 0))),
    ),
  );
  const ticks = integerTicks(max);
  const colorOf = new Map(model.series.map((s) => [s.dataKey, s.color]));
  const nameOf = new Map(model.series.map((s) => [s.dataKey, s.label]));
  const catLabel = (key: string | number) => model.labelOf.get(String(key)) ?? String(key);
  const n = data.series.length;

  const Tooltip = ({ id, value, indexValue, color }: BarTooltipProps<BarDatum>) => (
    <TooltipBox
      title={catLabel(indexValue)}
      classes={cls}
      lines={[{ key: String(id), color, text: `${nameOf.get(String(id)) ?? id}: ${valueFormatter(value)}` }]}
    />
  );

  return (
    <ChartShell
      kind={mode}
      title={title}
      description={description}
      summary={model.summary(kindLabel ?? BAR_MODE_LABEL[mode])}
      height={chartHeight}
      theme={theme}
      legend={model.legend}
      table={model.table("Categoria")}
      className={className}
    >
      {(width) => {
        const margin = horizontal
          ? { top: 4, right: labeled ? 40 : 12, bottom: 28, left: 96 }
          : { top: 22, right: 8, bottom: 28, left: 48 };
        const innerWidth = width - margin.left - margin.right;
        const innerHeight = chartHeight - margin.top - margin.bottom;
        const padding = horizontal
          ? bandPadding(innerHeight, data.categories.length, n * 14 + (n - 1) * 2, 0.15)
          : bandPadding(innerWidth, data.categories.length, stacked ? 40 : n * 28 + (n - 1) * 2);
        const thinned = horizontal
          ? { ticks: data.categories.map((c) => c.key), maxChars: MAX_TICK_CHARS }
          : thinCategories(
              data.categories.map((c) => c.key),
              innerWidth,
            );
        const valueAxis = {
          tickValues: ticks,
          tickSize: 0,
          tickPadding: 6,
          format: (v: number | string) => valueFormatter(Number(v)),
        };
        const categoryAxis = {
          tickValues: thinned.ticks,
          tickSize: 0,
          tickPadding: 8,
          format: (v: number | string) => truncate(catLabel(v), thinned.maxChars),
        };
        return (
          <ResponsiveBar<BarDatum>
            data={ordered}
            keys={model.series.map((s) => s.dataKey)}
            indexBy={INDEX_KEY}
            layout={horizontal ? "horizontal" : "vertical"}
            groupMode={stacked ? "stacked" : "grouped"}
            margin={margin}
            padding={padding}
            innerPadding={stacked ? 0 : 2}
            valueScale={{ type: "linear", min: 0, max: ticks[ticks.length - 1], nice: false }}
            indexScale={{ type: "band", round: true }}
            colors={({ id }) => colorOf.get(String(id)) ?? palette.neutral}
            borderRadius={4}
            borderWidth={stacked ? 1 : 0}
            borderColor={palette.ground}
            enableGridX={horizontal}
            enableGridY={!horizontal}
            gridXValues={horizontal ? ticks : undefined}
            gridYValues={horizontal ? undefined : ticks}
            axisTop={null}
            axisRight={null}
            axisBottom={horizontal ? valueAxis : categoryAxis}
            axisLeft={horizontal ? categoryAxis : valueAxis}
            enableLabel={labeled}
            label={(d) => valueFormatter(d.value ?? 0)}
            labelPosition="end"
            labelOffset={6}
            labelSkipWidth={horizontal ? 0 : 14}
            labelSkipHeight={horizontal ? 10 : 0}
            labelTextColor={palette.tick}
            enableTotals={stacked}
            totalsOffset={8}
            valueFormat={(v) => valueFormatter(v)}
            tooltip={Tooltip}
            theme={nivoTheme(theme)}
            animate={false}
            role="presentation"
            isFocusable={false}
          />
        );
      }}
    </ChartShell>
  );
}

/** Barras agrupadas (uma barra por série em cada categoria), cantos arredondados e rótulos. */
export function AnimatedGroupedBarChart(props: AnimatedSeriesChartProps) {
  return <BarSeriesChart mode="grouped" {...props} />;
}

/** Barras empilhadas (séries somadas em cada categoria; total no topo). */
export function AnimatedStackedBarChart(props: AnimatedSeriesChartProps) {
  return <BarSeriesChart mode="stacked" {...props} />;
}

/** Barras horizontais (categorias no eixo vertical; altura acompanha a quantidade). */
export function AnimatedHorizontalBarChart(props: AnimatedSeriesChartProps) {
  return <BarSeriesChart mode="horizontal" {...props} />;
}

// -----------------------------------------------------------------------------
// Série única categórica (situação → "Barras"); seleção pela legenda ou clique
// -----------------------------------------------------------------------------

const VALUE_KEY = "value";

export function CategoryBarChart(props: AnimatedChartProps) {
  const {
    title,
    description,
    valueLabel = "Valor",
    valueFormatter = defaultFormatter,
    selectedKey = null,
    onSelectKey,
    height = 240,
    theme = "screen",
    className,
  } = props;
  const model = useCategoryModel({ ...props, kind: "bar" });
  const cls = chartClasses(theme);
  if (model.rows.length === 0) return null;

  const byKey = new Map(model.rows.map((row) => [row.key, row]));
  const data: BarDatum[] = model.rows.map((row) => ({ [INDEX_KEY]: row.key, [VALUE_KEY]: row.value }));
  const ticks = integerTicks(Math.max(0, ...model.rows.map((row) => row.value)));
  const labeled = model.rows.length <= MAX_LABELED_MARKS;
  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);

  const Tooltip = ({ indexValue, value }: BarTooltipProps<BarDatum>) => (
    <TooltipBox
      title={byKey.get(String(indexValue))?.label ?? String(indexValue)}
      classes={cls}
      lines={[{ key: "v", text: `${valueLabel}: ${valueFormatter(value)}` }]}
    />
  );

  return (
    <ChartShell
      kind="bar"
      title={title}
      description={description}
      summary={model.summary}
      height={height}
      theme={theme}
      legend={model.legend}
      table={model.table}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      className={className}
    >
      {(width) => {
        const margin = { top: 22, right: 8, bottom: 28, left: 48 };
        const innerWidth = width - margin.left - margin.right;
        const thinned = thinCategories(
          data.map((d) => d[INDEX_KEY] as string),
          innerWidth,
        );
        return (
          <ResponsiveBar<BarDatum>
            data={data}
            keys={[VALUE_KEY]}
            indexBy={INDEX_KEY}
            margin={margin}
            padding={bandPadding(innerWidth, data.length, 40)}
            valueScale={{ type: "linear", min: 0, max: ticks[ticks.length - 1], nice: false }}
            indexScale={{ type: "band", round: true }}
            colors={({ indexValue }) => {
              const row = byKey.get(String(indexValue));
              return row ? withAlpha(model.fillFor(row), model.opacityFor(row)) : model.palette.neutral;
            }}
            borderRadius={4}
            enableGridY
            gridYValues={ticks}
            axisTop={null}
            axisRight={null}
            axisBottom={{
              tickValues: thinned.ticks,
              tickSize: 0,
              tickPadding: 8,
              format: (v: string | number) => truncate(byKey.get(String(v))?.label ?? String(v), thinned.maxChars),
            }}
            axisLeft={{
              tickValues: ticks,
              tickSize: 0,
              tickPadding: 6,
              format: (v: string | number) => valueFormatter(Number(v)),
            }}
            enableLabel={labeled}
            label={(d) => valueFormatter(d.value ?? 0)}
            labelPosition="end"
            labelOffset={6}
            labelSkipWidth={14}
            labelTextColor={model.palette.tick}
            valueFormat={(v) => valueFormatter(v)}
            tooltip={Tooltip}
            onClick={(datum) => {
              const key = String(datum.indexValue);
              if (onSelectKey && byKey.get(key)?.key && key !== OTHERS_KEY) toggle(key);
            }}
            theme={nivoTheme(theme)}
            animate={false}
            role="presentation"
            isFocusable={false}
          />
        );
      }}
    </ChartShell>
  );
}
