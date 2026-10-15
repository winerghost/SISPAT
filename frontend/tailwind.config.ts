import type { Config } from "tailwindcss";

// =============================================================================
// SISPAT-AGU — tailwind.config.ts
// =============================================================================
// Tokens espelhados 1:1 do DESIGN.md (Design System "Factory"). NÃO altere
// estes valores sem atualizar DESIGN.md primeiro — este arquivo é apenas a
// tradução dos tokens para utilitários Tailwind, nunca a fonte da verdade.
//
// Mapeamento de decisões (ver também globals.css para as CSS custom
// properties correspondentes):
//  - Cores: os 10 tokens da tabela "Tokens — Colors" do DESIGN.md, expostos
//    com os mesmos nomes de token (sem o prefixo "color-").
//  - Tipografia: fontFamily.sans/mono apontam para as variáveis CSS geradas
//    pelo next/font (pacote "geist") com fallback exatamente como descrito
//    no DESIGN.md (Inter/system-ui e JetBrains Mono/ui-monospace).
//  - fontSize: em rem (12/14/16/36/44/72px a 100%) para que o tamanho de fonte
//    da preferência de Aparência (root font-size 100/112/125%) escale a UI.
//  - fontSize: cada papel do "Type Scale" (caption, body-sm, body, heading,
//    heading-lg, display) vira uma chave de fontSize com [tamanho, {lineHeight,
//    letterSpacing}] — permitindo `text-caption`, `text-heading`, etc.
//  - Spacing: a escala de 8 a 120px do DESIGN.md já coincide com a escala
//    numérica padrão do Tailwind (base 4px) em quase todos os pontos (p-2 =
//    8px, p-4 = 16px, p-6 = 24px, p-8 = 32px, p-10 = 40px, p-14 = 56px,
//    p-20 = 80px, p-24 = 96px); a única lacuna é 120px, adicionada como
//    chave "30". Também expomos aliases semânticos (section-gap,
//    card-padding, element-gap) para uso direto nos componentes de layout.
//  - borderRadius: nav/buttons = 3px, cards = 10px, largePanels = 20px,
//    mapeados tanto na escala padrão (sm/lg/2xl) quanto em aliases
//    semânticos (nav, buttons, cards, panel).
//  - boxShadow: o documento define "zero dependência de sombra" — nenhuma
//    camada de blur/glow é adicionada. O único token de elevação observado
//    é uma hairline 1px, exposta aqui como `shadow-hairline` para o caso
//    raro em que uma borda 1px precise ser simulada via shadow (ex.: ring
//    de foco). Prefira sempre `border` com `ash-stroke` à sombra.
// =============================================================================

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/features/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "obsidian-canvas": "#101010",
        "carbon-lift": "#1d1a18",
        "ash-stroke": "#3d3a39",
        "graphite-mid": "#4d4947",
        "warm-granite": "#8a8380",
        "pale-stone": "#b8b3b0",
        bone: "#eeeeee",
        chalk: "#fafafa",
        "signal-orange": "#ee6018",
        "metric-green": "#a0ca92",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: [
          "var(--font-geist-mono)",
          "JetBrains Mono",
          "IBM Plex Mono",
          "ui-monospace",
          "monospace",
        ],
      },
      fontSize: {
        caption: ["0.75rem", { lineHeight: "1", letterSpacing: "-0.24px" }],
        "body-sm": ["0.875rem", { lineHeight: "1.43" }],
        body: ["1rem", { lineHeight: "1.5" }],
        heading: ["2.25rem", { lineHeight: "1.1", letterSpacing: "-1.12px" }],
        "heading-lg": ["2.75rem", { lineHeight: "1.12", letterSpacing: "-1.1px" }],
        display: ["4.5rem", { lineHeight: "1", letterSpacing: "-2.88px" }],
      },
      fontWeight: {
        regular: "400",
        medium: "500",
      },
      spacing: {
        "30": "120px", // 120px não existe na escala padrão do Tailwind (base 4px)
        // Aliases semânticos via variável: a densidade (compact) os reduz em globals.css.
        "section-gap": "var(--section-gap)",
        "card-padding": "var(--card-padding)",
        "element-gap": "var(--element-gap)",
      },
      maxWidth: {
        page: "1200px",
      },
      borderRadius: {
        sm: "3px", // nav / buttons
        lg: "10px", // cards
        "2xl": "20px", // largePanels
        nav: "3px",
        buttons: "3px",
        cards: "10px",
        panel: "20px",
      },
      boxShadow: {
        hairline: "0 0 0 1px #1d1a18",
      },
      // Motion — espelha src/lib/motion/tokens.ts (DESIGN.md > Motion Philosophy:
      // 150–200ms, cubic-bezier(0.4, 0, 0.2, 1); "slow" só p/ entradas nomeadas).
      transitionDuration: {
        DEFAULT: "150ms",
        fast: "150ms",
        base: "200ms",
        slow: "320ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)",
        factory: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      // Keyframes animam só opacity/transform/scale. `scale` (propriedade
      // individual) compõe com o translate(-50%,-50%) do Dialog sem sobrescrevê-lo.
      keyframes: {
        "sf-fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "sf-fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "sf-dialog-in": {
          from: { opacity: "0", scale: "0.98" },
          to: { opacity: "1", scale: "1" },
        },
        "sf-dialog-out": {
          from: { opacity: "1", scale: "1" },
          to: { opacity: "0", scale: "0.98" },
        },
        "sf-slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Única entrada nomeada do DESIGN.md (Motion Philosophy).
        sfDashboardFrameIn: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "sf-spin": { to: { transform: "rotate(360deg)" } },
      },
      animation: {
        "fade-in": "sf-fade-in 200ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "fade-out": "sf-fade-out 150ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "dialog-in": "sf-dialog-in 200ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "dialog-out": "sf-dialog-out 150ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "slide-up": "sf-slide-up 200ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "dashboard-frame-in": "sfDashboardFrameIn 320ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "spin-slow": "sf-spin 0.8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
