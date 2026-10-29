"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { chartClasses, chartPalette, type ChartClasses, type ChartPalette, type ChartThemeName } from "./chart-theme";
import type { ChartDatum, ChartKind, MultiSeriesChartData } from "./types";

// =============================================================================
// Casca comum dos gráficos Nivo do dashboard (sem dependência do Nivo).
// =============================================================================
// - figure + figcaption + contêiner role="img" (nome = título + resumo com
//   TODOS os números) + legenda em texto + <table> alternativa (sr-only).
// - O SVG do Nivo fica dentro de um wrapper aria-hidden (a acessibilidade
//   interna do Nivo é desligada: role="presentation", isFocusable=false), para
//   não duplicar a leitura; a informação completa está na legenda e na tabela.
// - `data-chart-surface` marca o wrapper do SVG (seletor estável para testes).
// - Sem animação do Nivo (animate={false}): nada de mola; a única entrada é a
//   opacidade do <FadeIn> do painel (200 ms, respeita reduced motion).
// - O Responsive* do Nivo mede o contêiner (largura 100%): o SVG nunca alarga
//   a página (320–1920 px); o próprio <svg> recorta o que passa da margem. O
//   tooltip do Nivo vira para o lado de dentro (âncora automática).
// =============================================================================

export const OTHERS_KEY = "__outros__";
/** Acima disto os rótulos de dados poluem o gráfico; a tabela cobre o resto. */
export const MAX_LABELED_MARKS = 16;
export const MAX_TICK_CHARS = 12;

/** Textura da série (além da cor): a cor nunca é a única pista (WCAG 1.4.1). */
export type SeriesPattern = "solid" | "lines" | "dots";

/** Estilo fixo de uma série (cor semântica + textura), por chave ORIGINAL da série. */
export interface SeriesStyle {
  color: string;
  pattern?: SeriesPattern;
}

/** Miniatura da textura na legenda (CSS puro; mesma leitura das barras). */
export function patternSwatchStyle(color: string, pattern: SeriesPattern | undefined, ground: string) {
  if (pattern === "lines") {
    return { backgroundImage: `repeating-linear-gradient(-45deg, ${color} 0 2px, ${ground} 2px 4px)`, backgroundColor: color };
  }
  if (pattern === "dots") {
    return {
      backgroundImage: `radial-gradient(circle, ${ground} 0 1px, transparent 1.4px)`,
      backgroundSize: "4px 4px",
      backgroundColor: color,
    };
  }
  return { backgroundColor: color };
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  pattern?: SeriesPattern;
  opacity?: number;
  /** Valor formatado ao lado do rótulo (pizza/barras). */
  valueText?: string;
  selectable?: boolean;
}

export interface TableSpec {
  /** Cabeçalho da primeira coluna (categoria). */
  rowHeader: string;
  columns: string[];
  rows: { key: string; label: string; cells: string[] }[];
}

export const defaultFormatter = (() => {
  const nf = new Intl.NumberFormat("pt-BR");
  return (n: number) => nf.format(n);
})();

export const truncate = (text: string, max = MAX_TICK_CHARS) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// -----------------------------------------------------------------------------
// Medição da largura (rarefação de rótulos de eixo e largura máxima de barra)
// -----------------------------------------------------------------------------

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Escala inteira "bonita" (sem casas decimais): 0..max em ~`count` passos. */
export function integerTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

/**
 * Até `maxTicks` categorias visíveis no eixo, ancoradas na mais recente, e o
 * número de caracteres que cabe em cada rótulo (~7,5 px por caractere a 12 px, com folga de 10 px).
 */
export function thinCategories<T>(
  items: readonly T[],
  innerWidth: number,
  minSpacing = 64,
): { ticks: T[]; maxChars: number } {
  const width = innerWidth > 0 ? innerWidth : 600;
  const maxTicks = Math.max(2, Math.floor(width / minSpacing));
  const step = items.length <= maxTicks ? 1 : Math.ceil(items.length / maxTicks);
  const ticks = items.filter((_, i) => (items.length - 1 - i) % step === 0);
  const perTick = width / Math.max(1, items.length) * step;
  const maxChars = Math.max(4, Math.min(MAX_TICK_CHARS, Math.floor((perTick - 10) / 7.5)));
  return { ticks, maxChars };
}

// -----------------------------------------------------------------------------
// Casca: figure + legenda + tabela alternativa
// -----------------------------------------------------------------------------

export interface ChartShellProps {
  title: string;
  description?: string;
  summary: string;
  height: number;
  theme: ChartThemeName;
  legend: LegendItem[];
  table: TableSpec;
  /** Tipo (para `data-chart-kind`, útil em testes/estilos). */
  kind: string;
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  /** Prefixo (só leitor de tela) do nome dos botões da legenda, ex. "Filtrar por situação:". */
  selectActionLabel?: string;
  /** Marcas clicáveis (cursor de ponteiro na superfície do gráfico). */
  interactive?: boolean;
  className?: string;
  /** Recebe a largura medida do contêiner (0 antes da 1ª medição). */
  children: (width: number) => ReactNode;
}

export function ChartShell({
  title,
  description,
  summary,
  height,
  theme,
  legend,
  table,
  kind,
  selectedKey = null,
  onSelectKey,
  selectActionLabel,
  interactive = false,
  className,
  children,
}: ChartShellProps) {
  const titleId = useId();
  const cls = chartClasses(theme);
  const palette = chartPalette(theme);
  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);
  const { ref, width } = useElementWidth<HTMLDivElement>();

  return (
    <figure
      aria-labelledby={titleId}
      data-chart-kind={kind}
      className={cn("flex min-w-0 flex-col gap-4 border p-5 print:break-inside-avoid", cls.figure, className)}
    >
      <figcaption className="flex flex-col gap-1">
        <span id={titleId} className={cn("text-eyebrow", cls.title)}>
          {title}
        </span>
        {description && <span className={cn("text-body-sm", cls.description)}>{description}</span>}
      </figcaption>

      {/* role="img": o nome resume o gráfico; os detalhes estão na legenda e na tabela. */}
      <div
        ref={ref}
        role="img"
        aria-label={`${title}. ${summary}`}
        className="relative w-full min-w-0"
        style={{ height }}
      >
        <div
          aria-hidden="true"
          data-chart-surface="nivo"
          data-chart-interactive={interactive || undefined}
          className={cn("h-full w-full", interactive && "[&_path]:cursor-pointer [&_rect]:cursor-pointer")}
        >
          {children(width)}
        </div>
      </div>

      {/* Legenda acessível (texto; a cor nunca é a única pista). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label={`Legenda — ${title}`}>
        {legend.map((item) => {
          const content = (
            <>
              {item.pattern ? (
                <span
                  aria-hidden="true"
                  data-legend-pattern={item.pattern}
                  className="h-3 w-3 shrink-0 rounded-[2px]"
                  style={{ ...patternSwatchStyle(item.color, item.pattern, palette.ground), opacity: item.opacity }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color, opacity: item.opacity }}
                />
              )}
              <span className={cn("text-body-sm", cls.legendLabel)}>{item.label}</span>
              {item.valueText !== undefined && (
                <span className={cn("text-body-sm tabular-nums", cls.legendValue)}>{item.valueText}</span>
              )}
            </>
          );
          return (
            <li key={item.key} data-focus-id={`legend:${item.key}`}>
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
                  {selectActionLabel ? <span className="sr-only">{`${selectActionLabel} `}</span> : null}
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

// -----------------------------------------------------------------------------
// Tooltips (HTML; ficam dentro do wrapper aria-hidden — só reforço visual)
// -----------------------------------------------------------------------------

export function TooltipBox({
  title,
  lines,
  classes,
}: {
  title: string;
  lines: { key: string; text: string; color?: string }[];
  classes: ChartClasses;
}) {
  return (
    <div className={cn("rounded-nav border px-3 py-2", classes.tooltip)}>
      <p className={cn("text-eyebrow", classes.tooltipTitle)}>{title}</p>
      {lines.map((line) => (
        <p key={line.key} className={cn("flex items-center gap-2 text-body-sm tabular-nums", classes.tooltipText)}>
          {line.color && (
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
          )}
          {line.text}
        </p>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Modelos de dados (categórico e várias séries)
// -----------------------------------------------------------------------------

export interface CategoryRow extends ChartDatum {
  color: string;
}

/** Categorias com cor fixa; a partir da última cor, o resto vira "Outros". */
export function toCategoryRows(kind: ChartKind, data: ChartDatum[], palette: ChartPalette): CategoryRow[] {
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

export function categoryKindLabel(kind: ChartKind): string {
  return kind === "bar" ? "Gráfico de barras" : kind === "pie" ? "Gráfico de pizza" : "Gráfico de rosca";
}

/** Props comuns dos gráficos categóricos (situação: pizza, rosca, barras). */
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
  /** Quais categorias aceitam seleção (padrão: todas menos "Outros"). */
  isSelectableKey?: (key: string) => boolean;
  /** Prefixo acessível dos botões da legenda (ex.: "Filtrar por vínculo:"). */
  selectActionLabel?: string;
  /** Altura do gráfico em px (padrão 240). */
  height?: number;
  /** Tema visual (padrão "screen"; "paper" = relatório impresso). */
  theme?: ChartThemeName;
  className?: string;
}

/** Legenda, tabela, resumo e cores de um gráfico categórico. */
export function useCategoryModel({
  kind,
  data,
  valueLabel = "Valor",
  valueFormatter = defaultFormatter,
  selectedKey = null,
  isSelectableKey,
  theme = "screen",
}: AnimatedChartProps) {
  const palette = chartPalette(theme);
  return useMemo(() => {
    const rows = toCategoryRows(kind, data, palette);
    const canSelect = (key: string) => key !== OTHERS_KEY && (isSelectableKey ? isSelectableKey(key) : true);
    const fillFor = (row: CategoryRow) => (kind === "bar" && row.key === selectedKey ? palette.highlight : row.color);
    const opacityFor = (row: CategoryRow) => (selectedKey && row.key !== selectedKey ? 0.35 : 1);
    const legend: LegendItem[] = rows.map((row) => ({
      key: row.key,
      label: row.label,
      color: fillFor(row),
      opacity: opacityFor(row),
      valueText: valueFormatter(row.value),
      selectable: canSelect(row.key),
    }));
    const table: TableSpec = {
      rowHeader: "Categoria",
      columns: [valueLabel],
      rows: rows.map((row) => ({ key: row.key, label: row.label, cells: [valueFormatter(row.value)] })),
    };
    const summary = `${categoryKindLabel(kind)}: ${rows
      .map((row) => `${row.label} ${valueFormatter(row.value)}`)
      .join("; ")}.`;
    return { rows, legend, table, summary, fillFor, opacityFor, palette, canSelect };
  }, [kind, data, palette, selectedKey, valueFormatter, valueLabel, isSelectableKey]);
}

/** Props comuns dos gráficos de várias séries (unidades e mensal). */
export interface AnimatedSeriesChartProps {
  title: string;
  description?: string;
  data: MultiSeriesChartData;
  valueFormatter?: (value: number) => string;
  height?: number;
  /** Substitui o tipo citado no resumo (ex.: "Gráfico de barras" para série única). */
  kindLabel?: string;
  theme?: ChartThemeName;
  className?: string;
  /**
   * Clique numa barra (chaves ORIGINAIS da categoria e da série). Ausente =
   * barras sem ação. A alternativa por teclado fica no painel (botões).
   */
  onMarkClick?: (categoryKey: string, seriesKey: string) => void;
  /**
   * Cor semântica + textura por chave de série (ex.: SIM/NAO/DESCONHECIDO).
   * Ausente = paleta categórica na ordem. Mantenha o objeto ESTÁVEL (constante de módulo).
   */
  seriesStyles?: Readonly<Record<string, SeriesStyle>>;
}

export interface SeriesModelSeries {
  key: string;
  label: string;
  values: Record<string, number | undefined>;
  /** Chave interna (s0, s1...) — nunca o texto do backend. */
  dataKey: string;
  color: string;
  pattern?: SeriesPattern;
}

export function useSeriesModel(
  data: MultiSeriesChartData,
  palette: ChartPalette,
  valueFormatter: (n: number) => string,
  styles?: Readonly<Record<string, SeriesStyle>>,
) {
  return useMemo(() => {
    const series: SeriesModelSeries[] = data.series.map((s, i) => {
      const style = styles?.[s.key];
      return {
        ...s,
        dataKey: `s${i}`,
        color: style?.color ?? palette.categorical[i % palette.categorical.length]!,
        pattern: style?.pattern,
      };
    });
    const valueOf = (s: SeriesModelSeries, categoryKey: string): number | null => {
      const value = s.values[categoryKey];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const labelOf = new Map(data.categories.map((c) => [c.key, c.label]));
    const legend: LegendItem[] = series.map((s) => ({ key: s.key, label: s.label, color: s.color, pattern: s.pattern }));
    const table = (rowHeader: string): TableSpec => ({
      rowHeader,
      columns: series.map((s) => s.label),
      rows: data.categories.map((category) => ({
        key: category.key,
        label: category.label,
        cells: series.map((s) => {
          const value = valueOf(s, category.key);
          return value === null ? "Sem dado" : valueFormatter(value);
        }),
      })),
    });
    const summary = (kind: string) =>
      `${kind}: ${series
        .map(
          (s) =>
            `${s.label} — ${data.categories
              .map((c) => {
                const value = valueOf(s, c.key);
                return `${c.label} ${value === null ? "sem dado" : valueFormatter(value)}`;
              })
              .join(", ")}`,
        )
        .join("; ")}.`;
    return { series, legend, table, summary, valueOf, labelOf };
  }, [data, palette, valueFormatter, styles]);
}

export function hasMarks(data: MultiSeriesChartData): boolean {
  return data.categories.length > 0 && data.series.length > 0;
}
