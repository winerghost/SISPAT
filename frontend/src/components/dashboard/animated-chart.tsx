"use client";

import { CategoryBarChart } from "./nivo-bar-charts";
import { PieChart } from "./nivo-pie-chart";
import type { AnimatedChartProps } from "./chart-shell";

// =============================================================================
// Fachada dos gráficos do dashboard (Nivo — @nivo/bar, @nivo/pie, @nivo/line).
// =============================================================================
// Mantém a API pública de antes (nomes "Animated*" preservados por
// compatibilidade; NÃO há animação de mola: todo gráfico usa animate={false};
// a entrada é a opacidade do <FadeIn> do painel). Implementações:
//   - nivo-bar-charts.tsx  → barras agrupadas/empilhadas/horizontais e série única
//   - nivo-pie-chart.tsx   → pizza/rosca
//   - nivo-line-charts.tsx → linhas/áreas
//   - chart-shell.tsx      → figure, role="img"+resumo, legenda e tabela alternativa
//   - chart-theme.ts       → paleta e tema Nivo (ÚNICO arquivo de cores)
// Para não baixar módulos que a tela não usa, prefira importar a variante
// diretamente (next/dynamic por módulo, como em dashboard-panels.tsx).
// =============================================================================

export type { AnimatedChartProps, AnimatedSeriesChartProps } from "./chart-shell";
export {
  AnimatedGroupedBarChart,
  AnimatedHorizontalBarChart,
  AnimatedStackedBarChart,
  CategoryBarChart,
} from "./nivo-bar-charts";
export { AnimatedAreaChart, AnimatedLineChart } from "./nivo-line-charts";
export { PieChart } from "./nivo-pie-chart";

/** Gráfico categórico: "bar" (barras simples), "pie" (pizza) ou "donut" (rosca). */
export function AnimatedChart(props: AnimatedChartProps) {
  return props.kind === "bar" ? <CategoryBarChart {...props} /> : <PieChart {...props} />;
}
