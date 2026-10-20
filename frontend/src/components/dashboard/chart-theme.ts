// =============================================================================
// chart-theme.ts — PALETA E TEMA ÚNICOS DOS GRÁFICOS DO DASHBOARD
// =============================================================================
// Este é o ÚNICO arquivo que define cores, classes de aparência e o TEMA NIVO
// (`nivoTheme`) dos gráficos (barras, pizza/rosca, linhas e áreas) e dos
// cartões de indicador. Para trocar a paleta, edite os objetos
// `SCREEN_PALETTE` / `PAPER_PALETTE` abaixo — nenhum componente de gráfico tem
// cor própria. (A paleta padrão do Nivo, #61cdbb/#e8a838/#f47560..., NUNCA é
// usada: todo gráfico recebe `colors` e `theme` daqui.)
//
// Origem: tokens Factory do DESIGN.md (graphite-mid, warm-granite, pale-stone,
// bone, signal-orange, metric-green...). Não introduza cores fora dos tokens
// ("Don't: additional accent colors"); nada de paletas estilo #61cdbb.
//
// Temas:
//  - "screen": tema Factory dark (canvas #101010) — telas do app.
//  - "paper":  figura clara sobre papel (cartão Bone #eeeeee, texto #101010) —
//    usado pelo relatório imprimível. Verde (#a0ca92) fica de fora porque não
//    tem contraste suficiente sobre Bone; a distinção entre séries também vem
//    de legenda textual e tabela alternativa (a cor nunca é a única pista).
//
// Regra de uso das cores categóricas: a ordem é FIXA (a cor segue a entidade,
// nunca o ranking) e, passada a última cor, as demais categorias são somadas
// em "Outros" pelos componentes.
// =============================================================================

// Import SÓ de tipo (apagado na compilação): este arquivo é carregado junto
// da página; o código do Nivo continua só no chunk dinâmico dos gráficos.
import type { BarDatum, BarSvgProps } from "@nivo/bar";

export type ChartThemeName = "screen" | "paper";

/** Tokens do DESIGN.md (hex idêntico a `--color-*`). */
export const TOKENS = {
  canvas: "#101010",
  carbon: "#1d1a18",
  ash: "#3d3a39",
  graphite: "#4d4947",
  granite: "#8a8380",
  stone: "#b8b3b0",
  bone: "#eeeeee",
  chalk: "#fafafa",
  orange: "#ee6018",
  green: "#a0ca92",
} as const;

export interface ChartPalette {
  /** Cor de separação entre fatias/pontos (igual ao fundo da figura). */
  ground: string;
  /** Linhas de grade horizontais. */
  grid: string;
  /** Eixo base. */
  axis: string;
  /** Texto de eixos e rótulos de dados. */
  tick: string;
  /** Série única (barras simples) — neutro. */
  neutral: string;
  /** Categoria selecionada. */
  highlight: string;
  /** Ordem categórica fixa (séries e fatias). */
  categorical: readonly string[];
  /** Fundo do cursor de hover das barras. */
  cursor: string;
}

const SCREEN_PALETTE: ChartPalette = {
  ground: TOKENS.canvas,
  grid: TOKENS.carbon,
  axis: TOKENS.ash,
  tick: TOKENS.granite,
  neutral: TOKENS.granite,
  highlight: TOKENS.bone,
  categorical: [TOKENS.orange, TOKENS.green, TOKENS.bone, TOKENS.granite],
  cursor: TOKENS.bone,
};

const PAPER_PALETTE: ChartPalette = {
  ground: TOKENS.bone,
  grid: TOKENS.stone,
  axis: TOKENS.graphite,
  tick: TOKENS.graphite,
  neutral: TOKENS.graphite,
  highlight: TOKENS.canvas,
  categorical: [TOKENS.canvas, TOKENS.orange, TOKENS.graphite, TOKENS.granite],
  cursor: TOKENS.canvas,
};

export function chartPalette(theme: ChartThemeName = "screen"): ChartPalette {
  return theme === "paper" ? PAPER_PALETTE : SCREEN_PALETTE;
}

/** Classes Tailwind (tokens do DESIGN.md) por tema — textos, bordas e fundos. */
export interface ChartClasses {
  figure: string;
  title: string;
  description: string;
  legendLabel: string;
  legendValue: string;
  legendHover: string;
  focusRing: string;
  tooltip: string;
  tooltipTitle: string;
  tooltipText: string;
  /** Cartão de indicador (StatCard). */
  statBorder: string;
  statLabel: string;
  statValue: string;
  statMuted: string;
}

const SCREEN_CLASSES: ChartClasses = {
  figure: "border-carbon-lift",
  title: "text-pale-stone",
  description: "text-warm-granite",
  legendLabel: "text-bone",
  legendValue: "text-warm-granite",
  legendHover: "hover:text-chalk",
  focusRing: "focus-visible:ring-bone",
  tooltip: "border-ash-stroke bg-obsidian-canvas",
  tooltipTitle: "text-pale-stone",
  tooltipText: "text-bone",
  statBorder: "border-carbon-lift",
  statLabel: "text-pale-stone",
  statValue: "text-bone",
  statMuted: "text-warm-granite",
};

const PAPER_CLASSES: ChartClasses = {
  figure: "border-graphite-mid/40",
  title: "text-graphite-mid",
  description: "text-graphite-mid",
  legendLabel: "text-obsidian-canvas",
  legendValue: "text-graphite-mid",
  legendHover: "hover:text-obsidian-canvas",
  focusRing: "focus-visible:ring-obsidian-canvas",
  tooltip: "border-graphite-mid bg-bone",
  tooltipTitle: "text-graphite-mid",
  tooltipText: "text-obsidian-canvas",
  statBorder: "border-graphite-mid/40",
  statLabel: "text-graphite-mid",
  statValue: "text-obsidian-canvas",
  statMuted: "text-graphite-mid",
};

export function chartClasses(theme: ChartThemeName = "screen"): ChartClasses {
  return theme === "paper" ? PAPER_CLASSES : SCREEN_CLASSES;
}

/** Mesma cor do token com opacidade (equivale ao antigo `fillOpacity`). */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return alpha >= 1 ? hex : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// -----------------------------------------------------------------------------
// Tema Nivo (gerado dos tokens acima; um objeto por tema, criado uma única vez)
// -----------------------------------------------------------------------------

/** Tipo de tema aceito por ResponsiveBar/ResponsivePie/ResponsiveLine. */
export type NivoTheme = NonNullable<BarSvgProps<BarDatum>["theme"]>;

/** Geist (next/font) — `--font-geist` é definida em globals.css. */
const FONT_SANS = "var(--font-geist)";
const FONT_MONO = "var(--font-geist-mono-stack)";

function buildNivoTheme(palette: ChartPalette): NivoTheme {
  const text = {
    fontFamily: FONT_SANS,
    fontSize: 12,
    // DESIGN.md: peso 400 (o total das barras empilhadas do Nivo vem com
    // atributo fontWeight="bold"; o estilo do tema tem precedência).
    fontWeight: 400,
    fill: palette.tick,
    outlineWidth: 0,
    outlineColor: "transparent",
    outlineOpacity: 0,
  };
  return {
    background: "transparent",
    text,
    axis: {
      domain: { line: { stroke: palette.axis, strokeWidth: 1 } },
      ticks: { line: { strokeWidth: 0 }, text },
      legend: { text },
    },
    grid: { line: { stroke: palette.grid, strokeWidth: 1 } },
    crosshair: {
      line: { stroke: palette.axis, strokeWidth: 1, strokeOpacity: 1, strokeDasharray: "4 4" },
    },
    labels: { text },
    dots: { text },
    markers: { lineColor: palette.axis, lineStrokeWidth: 1, text },
    legends: { text, title: { text } },
    annotations: { text },
    tooltip: {
      // Os componentes usam tooltips próprios (classes de `chartClasses`);
      // estes estilos cobrem qualquer tooltip padrão do Nivo.
      container: {
        background: palette.ground,
        color: palette.highlight,
        fontFamily: FONT_MONO,
        fontSize: 12,
        border: `1px solid ${palette.axis}`,
        borderRadius: 3,
        boxShadow: "none",
        padding: "8px 12px",
      },
      basic: { whiteSpace: "pre" },
      chip: { borderRadius: 9999 },
      table: {},
      tableCell: { padding: "2px 6px" },
      tableCellValue: { fontVariantNumeric: "tabular-nums" },
    },
  };
}

const SCREEN_NIVO_THEME = buildNivoTheme(SCREEN_PALETTE);
const PAPER_NIVO_THEME = buildNivoTheme(PAPER_PALETTE);

export function nivoTheme(theme: ChartThemeName = "screen"): NivoTheme {
  return theme === "paper" ? PAPER_NIVO_THEME : SCREEN_NIVO_THEME;
}
