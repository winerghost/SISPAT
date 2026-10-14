"use client";

import { useId, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

import type { ChartDatum, ChartKind } from "./types";

// =============================================================================
// AnimatedChart — wrapper do Recharts no tema Factory.
// =============================================================================
// - Dados SEMPRE por props (valores reais). Sem dados → não renderiza gráfico
//   (o chamador mostra o estado vazio).
// - Entrada das marcas: 320ms (DURATION.slow, entrada única), tooltip 150ms;
//   `isAnimationActive=false` sob prefers-reduced-motion.
// - Cores só do DESIGN.md. Barras: série única em warm-granite (contraste
//   ≥ 3:1 sobre o canvas), categoria selecionada em bone. Rosca: ordem fixa
//   (nunca ciclada) signal-orange → metric-green → bone → warm-granite; a
//   partir da 5ª categoria as restantes são somadas em "Outros" (a cor segue
//   a entidade, nunca o ranking). Validação de paleta (dataviz): CVD e
//   separação normal PASSAM; "faixa de luminosidade/croma" falha por desenho
//   (paleta monocromática do DESIGN.md) — compensado por codificação
//   secundária: legenda sempre visível com valores + tabela para leitores de
//   tela + espaço de 2px entre fatias.
// - Acessibilidade: o SVG é decorativo (aria-hidden); a informação está na
//   legenda (texto) e numa <table> sr-only. Seleção de categoria por botões
//   com aria-pressed (teclado), destacando-a no gráfico (fill-opacity 150ms).
// - ResponsiveContainer: ocupa a largura do contêiner (sem overflow).
// =============================================================================

const C = {
  canvas: "#101010",
  carbon: "#1d1a18",
  ash: "#3d3a39",
  granite: "#8a8380",
  stone: "#b8b3b0",
  bone: "#eeeeee",
  orange: "#ee6018",
  green: "#a0ca92",
} as const;

/** Ordem categórica fixa (DESIGN.md: dois acentos de dado + neutros). */
const CATEGORICAL = [C.orange, C.green, C.bone, C.granite] as const;
const OTHERS_KEY = "__outros__";

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
  className?: string;
}

interface Row extends ChartDatum {
  color: string;
}

const defaultFormatter = (() => {
  const nf = new Intl.NumberFormat("pt-BR");
  return (n: number) => nf.format(n);
})();

function toRows(kind: ChartKind, data: ChartDatum[]): Row[] {
  const clean = data.filter((d) => Number.isFinite(d.value) && d.value >= 0);
  if (kind === "bar") return clean.map((d) => ({ ...d, color: C.granite }));
  if (clean.length <= CATEGORICAL.length) {
    return clean.map((d, i) => ({ ...d, color: CATEGORICAL[i]! }));
  }
  const head = clean.slice(0, CATEGORICAL.length - 1);
  const rest = clean.slice(CATEGORICAL.length - 1);
  return [
    ...head.map((d, i) => ({ ...d, color: CATEGORICAL[i]! })),
    {
      key: OTHERS_KEY,
      label: `Outros (${rest.length})`,
      value: rest.reduce((sum, d) => sum + d.value, 0),
      color: CATEGORICAL[CATEGORICAL.length - 1]!,
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
  className,
}: AnimatedChartProps) {
  const reduced = usePrefersReducedMotion();
  const titleId = useId();
  const rows = useMemo(() => toRows(kind, data), [kind, data]);

  if (rows.length === 0) return null;

  const animation = {
    isAnimationActive: !reduced,
    animationDuration: DURATION_MS.slow,
    // Recharts só aceita palavras-chave; "ease-out" é o mais próximo de
    // cubic-bezier(0.4, 0, 0.2, 1) numa entrada.
    animationEasing: "ease-out" as const,
  };

  const fillFor = (row: Row) => (kind === "bar" && row.key === selectedKey ? C.bone : row.color);
  const opacityFor = (row: Row) => (selectedKey && row.key !== selectedKey ? 0.35 : 1);
  const cellStyle = { transition: `fill 150ms ${EASE_FACTORY_CSS}, fill-opacity 150ms ${EASE_FACTORY_CSS}` };
  const toggle = (key: string) => onSelectKey?.(selectedKey === key ? null : key);

  return (
    <figure
      aria-labelledby={titleId}
      className={cn("flex min-w-0 flex-col gap-4 border border-carbon-lift p-5", className)}
    >
      <figcaption className="flex flex-col gap-1">
        <span id={titleId} className="text-eyebrow text-pale-stone">
          {title}
        </span>
        {description && <span className="text-body-sm text-warm-granite">{description}</span>}
      </figcaption>

      <div aria-hidden="true" className="w-full min-w-0" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === "bar" ? (
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={C.carbon} />
              <XAxis
                dataKey="label"
                tick={{ fill: C.granite, fontSize: 12 }}
                axisLine={{ stroke: C.ash }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: C.granite, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={40}
                allowDecimals={false}
                tickFormatter={(v: number) => valueFormatter(v)}
              />
              <Tooltip
                cursor={{ fill: C.bone, fillOpacity: 0.04 }}
                content={<ChartTooltip valueLabel={valueLabel} format={valueFormatter} />}
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
            <PieChart>
              <Tooltip
                content={<ChartTooltip valueLabel={valueLabel} format={valueFormatter} />}
                animationDuration={DURATION_MS.fast}
                isAnimationActive={!reduced}
              />
              <Pie
                data={rows}
                dataKey="value"
                nameKey="label"
                innerRadius="58%"
                outerRadius="88%"
                stroke={C.canvas}
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
        </ResponsiveContainer>
      </div>

      {/* Legenda acessível (texto + valor; cor nunca é a única pista). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label={`Legenda — ${title}`}>
        {rows.map((row) => {
          const content = (
            <>
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: fillFor(row), opacity: opacityFor(row) }}
              />
              <span className="text-body-sm text-bone">{row.label}</span>
              <span className="text-body-sm tabular-nums text-warm-granite">{valueFormatter(row.value)}</span>
            </>
          );
          return (
            <li key={row.key}>
              {onSelectKey && row.key !== OTHERS_KEY ? (
                <button
                  type="button"
                  aria-pressed={row.key === selectedKey}
                  onClick={() => toggle(row.key)}
                  className="inline-flex min-h-6 items-center gap-2 rounded-nav px-1 transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
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
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Categoria</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{valueFormatter(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function ChartTooltip({
  active,
  payload,
  valueLabel,
  format,
}: TooltipProps<number, string> & { valueLabel: string; format: (n: number) => string }) {
  const item = payload?.[0];
  if (!active || !item) return null;
  const row = item.payload as Row | undefined;
  return (
    <div className="animate-fade-in rounded-nav border border-ash-stroke bg-obsidian-canvas px-3 py-2">
      <p className="text-eyebrow text-pale-stone">{row?.label ?? item.name}</p>
      <p className="text-body-sm tabular-nums text-bone">
        {valueLabel}: {format(Number(item.value ?? 0))}
      </p>
    </div>
  );
}
