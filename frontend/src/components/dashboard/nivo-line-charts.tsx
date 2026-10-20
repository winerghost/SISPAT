"use client";

import { ResponsiveLine, type SliceTooltipProps } from "@nivo/line";

import {
  ChartShell,
  MAX_LABELED_MARKS,
  TooltipBox,
  defaultFormatter,
  hasMarks,
  integerTicks,
  thinCategories,
  truncate,
  useSeriesModel,
  type AnimatedSeriesChartProps,
} from "./chart-shell";
import { chartClasses, chartPalette, nivoTheme } from "./chart-theme";

// =============================================================================
// Linhas e áreas (Nivo ResponsiveLine) no tema Factory.
// =============================================================================
// - Uma série por cor categórica (ordem fixa). Lacunas permanecem lacunas:
//   mês sem medição vira `y: null` (o Nivo interrompe a linha) — nada é
//   interpolado nem vira zero.
// - Área = enableArea (opacidade 0.18) sobre a linha.
// - Pontos com borda na cor do fundo; rótulos de valor quando há ≤ 16 pontos.
// - Tooltip por fatia vertical (todas as séries do mês). animate={false}.
// =============================================================================

interface LineDatum {
  x: string;
  y: number | null;
}

interface LineSerie {
  id: string;
  data: LineDatum[];
}

function SeriesLineChart({
  area,
  title,
  description,
  data,
  valueFormatter = defaultFormatter,
  height = 260,
  kindLabel,
  theme = "screen",
  className,
}: AnimatedSeriesChartProps & { area: boolean }) {
  const palette = chartPalette(theme);
  const cls = chartClasses(theme);
  const model = useSeriesModel(data, palette, valueFormatter);
  if (!hasMarks(data)) return null;

  const labeled = data.categories.length * data.series.length <= MAX_LABELED_MARKS;
  const series: LineSerie[] = model.series.map((s) => ({
    id: s.dataKey,
    data: data.categories.map((c) => ({ x: c.key, y: model.valueOf(s, c.key) })),
  }));
  const max = Math.max(
    0,
    ...model.series.flatMap((s) => data.categories.map((c) => model.valueOf(s, c.key) ?? 0)),
  );
  const ticks = integerTicks(max);
  const colorOf = new Map(model.series.map((s) => [s.dataKey, s.color]));
  const nameOf = new Map(model.series.map((s) => [s.dataKey, s.label]));
  const catLabel = (key: unknown) => model.labelOf.get(String(key)) ?? String(key);

  const SliceTooltip = ({ slice }: SliceTooltipProps<LineSerie>) => (
    <TooltipBox
      title={catLabel(slice.points[0]?.data.x)}
      classes={cls}
      lines={slice.points.map((point) => ({
        key: point.id,
        color: point.seriesColor,
        text: `${nameOf.get(String(point.seriesId)) ?? point.seriesId}: ${
          typeof point.data.y === "number" ? valueFormatter(point.data.y) : "Sem dado"
        }`,
      }))}
    />
  );

  return (
    <ChartShell
      kind={area ? "area" : "line"}
      title={title}
      description={description}
      summary={model.summary(kindLabel ?? (area ? "Gráfico de áreas" : "Gráfico de linhas"))}
      height={height}
      theme={theme}
      legend={model.legend}
      table={model.table("Período")}
      className={className}
    >
      {(width) => {
        const margin = { top: 24, right: 32, bottom: 28, left: 48 };
        const innerWidth = width - margin.left - margin.right;
        const thinned = thinCategories(
          data.categories.map((c) => c.key),
          innerWidth,
        );
        return (
          <ResponsiveLine<LineSerie>
            data={series}
            margin={margin}
            xScale={{ type: "point" }}
            yScale={{ type: "linear", min: 0, max: ticks[ticks.length - 1], stacked: false, nice: false }}
            yFormat={(v) => (typeof v === "number" ? valueFormatter(v) : "")}
            curve="linear"
            colors={(serie) => colorOf.get(String(serie.id)) ?? palette.neutral}
            lineWidth={2}
            enableArea={area}
            areaOpacity={0.18}
            areaBaselineValue={0}
            enablePoints
            pointSize={6}
            pointColor={{ from: "series.color" }}
            pointBorderWidth={1}
            pointBorderColor={palette.ground}
            enablePointLabel={labeled}
            pointLabel={(point) => (typeof point.data.y === "number" ? valueFormatter(point.data.y) : "")}
            pointLabelYOffset={-10}
            enableGridX={false}
            enableGridY
            gridYValues={ticks}
            axisTop={null}
            axisRight={null}
            axisBottom={{
              tickValues: thinned.ticks,
              tickSize: 0,
              tickPadding: 8,
              format: (v: unknown) => truncate(catLabel(v), thinned.maxChars),
            }}
            axisLeft={{
              tickValues: ticks,
              tickSize: 0,
              tickPadding: 6,
              format: (v: unknown) => valueFormatter(Number(v)),
            }}
            enableSlices="x"
            sliceTooltip={SliceTooltip}
            enableCrosshair
            crosshairType="x"
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

/** Áreas (uma por série); lacunas permanecem lacunas e nada é interpolado. */
export function AnimatedAreaChart(props: AnimatedSeriesChartProps) {
  return <SeriesLineChart area {...props} />;
}

/** Linhas (uma por série) com pontos e rótulos; lacunas permanecem lacunas. */
export function AnimatedLineChart(props: AnimatedSeriesChartProps) {
  return <SeriesLineChart area={false} {...props} />;
}
