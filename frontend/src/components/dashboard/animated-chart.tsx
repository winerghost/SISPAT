"use client";

import { useId, useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { DURATION_MS, EASE_FACTORY_CSS } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

import {
  chartClasses,
  chartPalette,
  type ChartClasses,
  type ChartPalette,
  type ChartThemeName,
} from "./chart-theme";
import type { ChartDatum, ChartKind, MultiSeriesChartData } from "./types";

// =============================================================================
// AnimatedChart — wrapper do Recharts no tema Factory (barras, rosca, barras
// agrupadas e linhas).
// =============================================================================
// - Dados SEMPRE por props (valores reais). Sem dados → não renderiza gráfico
//   (o chamador mostra o estado vazio).
// - Cores/classes: TODAS vêm de `./chart-theme` (arquivo único; troque lá).
// - Entrada das marcas: 320ms (DURATION.slow, entrada única), tooltip 150ms;
//   `isAnimationActive=false` sob prefers-reduced-motion.
// - Barras simples: série única neutra, categoria selecionada em destaque.
//   Rosca: ordem categórica fixa (nunca ciclada); a partir da 5ª categoria as
//   restantes são somadas em "Outros" (a cor segue a entidade, nunca o
//   ranking). A paleta monocromática do DESIGN.md é compensada por codificação
//   secundária: legenda sempre visível com valores + tabela para leitores de
//   tela + espaço de 2px entre fatias.
// - Barras agrupadas / linhas: uma cor categórica por série; legenda textual,
//   rótulos de dados quando há poucos pontos e tabela sr-only completa.
// - Acessibilidade: o SVG é decorativo (aria-hidden) dentro de um contêiner
//   role="img" com nome e resumo; a informação completa está na legenda
//   (texto) e numa <table> sr-only. Seleção por botões com aria-pressed.
// - ResponsiveContainer: ocupa a largura do contêiner (sem overflow).
// =============================================================================

const OTHERS_KEY = "__outros__";
/** Acima disto os rótulos de dados poluem o gráfico; a tabela cobre o resto. */
const MAX_LABELED_MARKS = 16;
const MAX_TICK_CHARS = 12;

interface LegendItem {
  key: string;
  label: string;
  color: string;
  opacity?: number;
  /** Valor formatado ao lado do rótulo (rosca/barras). */
  valueText?: string;
  selectable?: boolean;
}

interface TableSpec {
  /** Cabeçalho da primeira coluna (categoria). */
  rowHeader: string;
  columns: string[];
  rows: { key: string; label: string; cells: string[] }[];
}

const defaultFormatter = (() => {
  const nf = new Intl.NumberFormat("pt-BR");
  return (n: number) => nf.format(n);
})();

const truncate = (text: string, max = MAX_TICK_CHARS) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// -----------------------------------------------------------------------------
// Casca comum: figure + legenda + tabela alternativa
// -----------------------------------------------------------------------------

interface ChartShellProps {
  title: string;
  description?: string;
  summary: string;
  height: number;
  theme: ChartThemeName;
  legend: LegendItem[];
  table: TableSpec;
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  className?: string;
  children: ReactNode;
}

function ChartShell({
  title,
  description,
  summary,
  height,
  theme,
  legend,
  table,
  selectedKey = null,
  onSelectKey,
  className,
  children,
}: ChartShellProps) {
  const titleId = useId();
  const cls = chartClasses(theme);
  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);

  return (
    <figure
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col gap-4 border p-5 print:break-inside-avoid",
        cls.figure,
        className,
      )}
    >
      <figcaption className="flex flex-col gap-1">
        <span id={titleId} className={cn("text-eyebrow", cls.title)}>
          {title}
        </span>
        {description && <span className={cn("text-body-sm", cls.description)}>{description}</span>}
      </figcaption>

      {/* role="img": o nome resume o gráfico; os detalhes estão na legenda e na tabela. */}
      <div role="img" aria-label={`${title}. ${summary}`} className="w-full min-w-0" style={{ height }}>
        <div aria-hidden="true" className="h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      </div>

      {/* Legenda acessível (texto; a cor nunca é a única pista). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label={`Legenda — ${title}`}>
        {legend.map((item) => {
          const content = (
            <>
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color, opacity: item.opacity }}
              />
              <span className={cn("text-body-sm", cls.legendLabel)}>{item.label}</span>
              {item.valueText !== undefined && (
                <span className={cn("text-body-sm tabular-nums", cls.legendValue)}>{item.valueText}</span>
              )}
            </>
          );
          return (
            <li key={item.key}>
              {onSelectKey && item.selectable ? (
                <button
                  type="button"
                  aria-pressed={item.key === selectedKey}
                  onClick={() => toggle(item.key)}
                  className={cn(
                    "inline-flex min-h-6 items-center gap-2 rounded-nav px-1 transition-factory focus-visible:outline-none focus-visible:ring-1",
                    cls.legendHover,
                    cls.focusRing,
                  )}
                >
                  {content}
                </button>
              ) : (
                <span className="inline-flex min-h-6 items-center gap-2 px-1">{content}</span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Alternativa para leitores de tela. */}
      <div className="sr-only">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{table.rowHeader}</th>
            {table.columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {row.cells.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

function useAnimation() {
  const reduced = usePrefersReducedMotion();
  return {
    reduced,
    animation: {
      isAnimationActive: !reduced,
      animationDuration: DURATION_MS.slow,
      // Recharts só aceita palavras-chave; "ease-out" é o mais próximo de
      // cubic-bezier(0.4, 0, 0.2, 1) numa entrada.
      animationEasing: "ease-out" as const,
    },
  };
}

// -----------------------------------------------------------------------------
// Barras simples e rosca
// -----------------------------------------------------------------------------

export interface AnimatedChartProps {
  kind: ChartKind;
  /** Título visível (figcaption) — também nomeia a tabela alternativa. */
  title: string;
  description?: string;
  data: ChartDatum[];
  /** Nome da medida (cabeçalho da tabela/tooltip). Padrão "Valor". */
  valueLabel?: string;
  /** Formatação dos valores (padrão pt-BR inteiro). */
  valueFormatter?: (value: number) => string;
  /** Categoria destacada (controlada). */
  selectedKey?: string | null;
  /** Habilita a seleção pela legenda (botões aria-pressed). */
  onSelectKey?: (key: string | null) => void;
  /** Altura do gráfico em px (padrão 240). */
  height?: number;
  /** Tema visual (padrão "screen"; "paper" = relatório impresso). */
  theme?: ChartThemeName;
  className?: string;
}

interface Row extends ChartDatum {
  color: string;
}

function toRows(kind: ChartKind, data: ChartDatum[], palette: ChartPalette): Row[] {
  const colors = palette.categorical;
  const clean = data.filter((d) => Number.isFinite(d.value) && d.value >= 0);
  if (kind === "bar") return clean.map((d) => ({ ...d, color: palette.neutral }));
  if (clean.length <= colors.length) {
    return clean.map((d, i) => ({ ...d, color: colors[i]! }));
  }
  const head = clean.slice(0, colors.length - 1);
  const rest = clean.slice(colors.length - 1);
  return [
    ...head.map((d, i) => ({ ...d, color: colors[i]! })),
    {
      key: OTHERS_KEY,
      label: `Outros (${rest.length})`,
      value: rest.reduce((sum, d) => sum + d.value, 0),
      color: colors[colors.length - 1]!,
    },
  ];
}

export function AnimatedChart({
  kind,
  title,
  description,
  data,
  valueLabel = "Valor",
  valueFormatter = defaultFormatter,
  selectedKey = null,
  onSelectKey,
  height = 240,
  theme = "screen",
  className,
}: AnimatedChartProps) {
  const { reduced, animation } = useAnimation();
  const palette = chartPalette(theme);
  const cls = chartClasses(theme);
  const rows = useMemo(() => toRows(kind, data, palette), [kind, data, palette]);

  if (rows.length === 0) return null;

  const fillFor = (row: Row) => (kind === "bar" && row.key === selectedKey ? palette.highlight : row.color);
  const opacityFor = (row: Row) => (selectedKey && row.key !== selectedKey ? 0.35 : 1);
  const cellStyle = { transition: `fill 150ms ${EASE_FACTORY_CSS}, fill-opacity 150ms ${EASE_FACTORY_CSS}` };
  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);

  const legend: LegendItem[] = rows.map((row) => ({
    key: row.key,
    label: row.label,
    color: fillFor(row),
    opacity: opacityFor(row),
    valueText: valueFormatter(row.value),
    selectable: row.key !== OTHERS_KEY,
  }));
  const table: TableSpec = {
    rowHeader: "Categoria",
    columns: [valueLabel],
    rows: rows.map((row) => ({ key: row.key, label: row.label, cells: [valueFormatter(row.value)] })),
  };
  const summary = `${kind === "bar" ? "Gráfico de barras" : "Gráfico de rosca"}: ${rows
    .map((row) => `${row.label} ${valueFormatter(row.value)}`)
    .join("; ")}.`;

  return (
    <ChartShell
      title={title}
      description={description}
      summary={summary}
      height={height}
      theme={theme}
      legend={legend}
      table={table}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      className={className}
    >
      {kind === "bar" ? (
        <BarChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={palette.grid} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.tick, fontSize: 12 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: palette.tick, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
            tickFormatter={(v: number) => valueFormatter(v)}
          />
          <Tooltip
            cursor={{ fill: palette.cursor, fillOpacity: 0.04 }}
            content={<ChartTooltip valueLabel={valueLabel} format={valueFormatter} classes={cls} />}
            animationDuration={DURATION_MS.fast}
            isAnimationActive={!reduced}
          />
          <Bar
            dataKey="value"
            name={valueLabel}
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            onClick={(entry: { key?: string }) => entry.key && onSelectKey && toggle(entry.key)}
            {...animation}
          >
            {rows.map((row) => (
              <Cell key={row.key} fill={fillFor(row)} fillOpacity={opacityFor(row)} style={cellStyle} />
            ))}
          </Bar>
        </BarChart>
      ) : (
        <PieChart accessibilityLayer={false}>
          <Tooltip
            content={<ChartTooltip valueLabel={valueLabel} format={valueFormatter} classes={cls} />}
            animationDuration={DURATION_MS.fast}
            isAnimationActive={!reduced}
          />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="label"
            rootTabIndex={-1}
            innerRadius="58%"
            outerRadius="88%"
            stroke={palette.ground}
            strokeWidth={2}
            onClick={(entry: { key?: string }) => entry.key && onSelectKey && toggle(entry.key)}
            {...animation}
          >
            {rows.map((row) => (
              <Cell key={row.key} fill={fillFor(row)} fillOpacity={opacityFor(row)} style={cellStyle} />
            ))}
          </Pie>
        </PieChart>
      )}
    </ChartShell>
  );
}

// -----------------------------------------------------------------------------
// Barras agrupadas e linhas (várias séries)
// -----------------------------------------------------------------------------

export interface AnimatedSeriesChartProps {
  title: string;
  description?: string;
  data: MultiSeriesChartData;
  valueFormatter?: (value: number) => string;
  height?: number;
  theme?: ChartThemeName;
  className?: string;
}

function useSeriesModel(data: MultiSeriesChartData, palette: ChartPalette, valueFormatter: (n: number) => string) {
  return useMemo(() => {
    const series = data.series.map((s, i) => ({
      ...s,
      dataKey: `s${i}`,
      color: palette.categorical[i % palette.categorical.length]!,
    }));
    const rows = data.categories.map((category) => {
      const row: Record<string, string | number | undefined> = { key: category.key, label: category.label };
      for (const s of series) {
        const value = s.values[category.key];
        row[s.dataKey] = typeof value === "number" && Number.isFinite(value) ? value : undefined;
      }
      return row;
    });
    const legend: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, color: s.color }));
    const table = (rowHeader: string): TableSpec => ({
      rowHeader,
      columns: series.map((s) => s.label),
      rows: data.categories.map((category) => ({
        key: category.key,
        label: category.label,
        cells: series.map((s) => {
          const value = s.values[category.key];
          return typeof value === "number" ? valueFormatter(value) : "Sem dado";
        }),
      })),
    });
    const summary = (kind: string) =>
      `${kind}: ${series
        .map(
          (s) =>
            `${s.label} — ${data.categories
              .map((c) => {
                const value = s.values[c.key];
                return `${c.label} ${typeof value === "number" ? valueFormatter(value) : "sem dado"}`;
              })
              .join(", ")}`,
        )
        .join("; ")}.`;
    return { series, rows, legend, table, summary };
  }, [data, palette, valueFormatter]);
}

function hasMarks(data: MultiSeriesChartData): boolean {
  return data.categories.length > 0 && data.series.length > 0;
}

const labelProps = (palette: ChartPalette) => ({
  fill: palette.tick,
  fontSize: 12,
});

/** Barras agrupadas (uma barra por série em cada categoria), cantos arredondados e rótulos. */
export function AnimatedGroupedBarChart({
  title,
  description,
  data,
  valueFormatter = defaultFormatter,
  height = 280,
  theme = "screen",
  className,
}: AnimatedSeriesChartProps) {
  const { reduced, animation } = useAnimation();
  const palette = chartPalette(theme);
  const cls = chartClasses(theme);
  const model = useSeriesModel(data, palette, valueFormatter);
  if (!hasMarks(data)) return null;
  const labeled = data.categories.length * data.series.length <= MAX_LABELED_MARKS;

  return (
    <ChartShell
      title={title}
      description={description}
      summary={model.summary("Gráfico de barras agrupadas")}
      height={height}
      theme={theme}
      legend={model.legend}
      table={model.table("Categoria")}
      className={className}
    >
      <BarChart accessibilityLayer={false} data={model.rows} margin={{ top: 20, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid vertical={false} stroke={palette.grid} />
        <XAxis
          dataKey="label"
          tick={{ fill: palette.tick, fontSize: 12 }}
          axisLine={{ stroke: palette.axis }}
          tickLine={false}
          interval="preserveStartEnd"
          tickFormatter={(v: string) => truncate(v)}
        />
        <YAxis
          tick={{ fill: palette.tick, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={40}
          allowDecimals={false}
          tickFormatter={(v: number) => valueFormatter(v)}
        />
        <Tooltip
          cursor={{ fill: palette.cursor, fillOpacity: 0.04 }}
          content={<MultiTooltip format={valueFormatter} classes={cls} />}
          animationDuration={DURATION_MS.fast}
          isAnimationActive={!reduced}
        />
        {model.series.map((s) => (
          <Bar
            key={s.dataKey}
            dataKey={s.dataKey}
            name={s.label}
            fill={s.color}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            {...animation}
          >
            {labeled && (
              <LabelList
                dataKey={s.dataKey}
                position="top"
                {...labelProps(palette)}
                formatter={(v: unknown) => (typeof v === "number" ? valueFormatter(v) : "")}
              />
            )}
          </Bar>
        ))}
      </BarChart>
    </ChartShell>
  );
}

/** Linhas (uma por série) com pontos e rótulos; lacunas permanecem lacunas. */
export function AnimatedLineChart({
  title,
  description,
  data,
  valueFormatter = defaultFormatter,
  height = 260,
  theme = "screen",
  className,
}: AnimatedSeriesChartProps) {
  const { reduced, animation } = useAnimation();
  const palette = chartPalette(theme);
  const cls = chartClasses(theme);
  const model = useSeriesModel(data, palette, valueFormatter);
  if (!hasMarks(data)) return null;
  const labeled = data.categories.length * data.series.length <= MAX_LABELED_MARKS;

  return (
    <ChartShell
      title={title}
      description={description}
      summary={model.summary("Gráfico de linhas")}
      height={height}
      theme={theme}
      legend={model.legend}
      table={model.table("Período")}
      className={className}
    >
      <LineChart accessibilityLayer={false} data={model.rows} margin={{ top: 20, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={palette.grid} />
        <XAxis
          dataKey="label"
          tick={{ fill: palette.tick, fontSize: 12 }}
          axisLine={{ stroke: palette.axis }}
          tickLine={false}
          interval="preserveStartEnd"
          padding={{ left: 12, right: 12 }}
        />
        <YAxis
          tick={{ fill: palette.tick, fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={40}
          allowDecimals={false}
          domain={[0, "auto"]}
          tickFormatter={(v: number) => valueFormatter(v)}
        />
        <Tooltip
          cursor={{ stroke: palette.axis }}
          content={<MultiTooltip format={valueFormatter} classes={cls} />}
          animationDuration={DURATION_MS.fast}
          isAnimationActive={!reduced}
        />
        {model.series.map((s) => (
          <Line
            key={s.dataKey}
            type="linear"
            dataKey={s.dataKey}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={{ r: 3, fill: s.color, stroke: palette.ground, strokeWidth: 1 }}
            activeDot={{ r: 5, fill: s.color, stroke: palette.ground }}
            connectNulls={false}
            {...animation}
          >
            {labeled && (
              <LabelList
                dataKey={s.dataKey}
                position="top"
                {...labelProps(palette)}
                formatter={(v: unknown) => (typeof v === "number" ? valueFormatter(v) : "")}
              />
            )}
          </Line>
        ))}
      </LineChart>
    </ChartShell>
  );
}

// -----------------------------------------------------------------------------
// Tooltips
// -----------------------------------------------------------------------------

function ChartTooltip({
  active,
  payload,
  valueLabel,
  format,
  classes,
}: TooltipProps<number, string> & {
  valueLabel: string;
  format: (n: number) => string;
  classes: ChartClasses;
}) {
  const item = payload?.[0];
  if (!active || !item) return null;
  const row = item.payload as Row | undefined;
  return (
    <div className={cn("animate-fade-in rounded-nav border px-3 py-2", classes.tooltip)}>
      <p className={cn("text-eyebrow", classes.tooltipTitle)}>{row?.label ?? item.name}</p>
      <p className={cn("text-body-sm tabular-nums", classes.tooltipText)}>
        {valueLabel}: {format(Number(item.value ?? 0))}
      </p>
    </div>
  );
}

function MultiTooltip({
  active,
  payload,
  label,
  format,
  classes,
}: TooltipProps<number, string> & { format: (n: number) => string; classes: ChartClasses }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={cn("animate-fade-in rounded-nav border px-3 py-2", classes.tooltip)}>
      <p className={cn("text-eyebrow", classes.tooltipTitle)}>{String(label ?? "")}</p>
      {payload.map((item) => (
        <p key={String(item.dataKey)} className={cn("text-body-sm tabular-nums", classes.tooltipText)}>
          {item.name}: {typeof item.value === "number" ? format(item.value) : "Sem dado"}
        </p>
      ))}
    </div>
  );
}
