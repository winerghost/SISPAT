// =============================================================================
// Tokens de movimento — fonte única para Motion (JS) e CSS/Tailwind.
// =============================================================================
// DESIGN.md > Motion Philosophy: "Transitions are short and mechanical:
// 0.15s–0.2s with cubic-bezier(0.4, 0, 0.2, 1) easing — the feel of a CLI
// tool, not a marketing site". Sem spring, bounce, parallax ou scroll-driven.
// Os valores CSS equivalentes vivem em globals.css (--motion-*) e em
// tailwind.config.ts (duration-fast/base/slow, ease-factory); mantenha-os
// sincronizados com este arquivo.
// =============================================================================

/** Durações em SEGUNDOS (unidade do Motion). */
export const DURATION = {
  /** Troca de estado: cor, borda, hover, press. */
  fast: 0.15,
  /** Entradas/saídas de elementos (fade, slide, modal, página). */
  base: 0.2,
  /**
   * Somente para entradas NOMEADAS e únicas (ex.: sfDashboardFrameIn).
   * Nunca usar em interações recorrentes.
   */
  slow: 0.32,
} as const;

/** Durações em milissegundos (para CSS/setTimeout). */
export const DURATION_MS = {
  fast: 150,
  base: 200,
  slow: 320,
} as const;

/** Easing único do sistema: cubic-bezier(0.4, 0, 0.2, 1). */
export const EASE_FACTORY = [0.4, 0, 0.2, 1] as const satisfies readonly [
  number,
  number,
  number,
  number,
];

/** Mesmo easing como string CSS. */
export const EASE_FACTORY_CSS = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Deslocamentos (px) — pequenos, nunca "voo" de elementos. */
export const DISTANCE = {
  /** Transição de página e listas. */
  sm: 4,
  /** Entradas de seções/cards. */
  md: 8,
} as const;

/** Escala mínima de entrada (modal/popover): 0.98 → 1. */
export const SCALE_IN_FROM = 0.98;

/** Stagger: intervalo entre itens e limite de itens animados. */
export const STAGGER = {
  /** Segundos entre itens. */
  interval: 0.03,
  /** Só os primeiros N itens recebem atraso; o resto entra junto. */
  maxItems: 12,
} as const;

/** Transição padrão do Motion (tween, nunca spring). */
export const TRANSITION_BASE = {
  type: "tween",
  duration: DURATION.base,
  ease: EASE_FACTORY,
} as const;

export const TRANSITION_FAST = {
  type: "tween",
  duration: DURATION.fast,
  ease: EASE_FACTORY,
} as const;

export const TRANSITION_SLOW = {
  type: "tween",
  duration: DURATION.slow,
  ease: EASE_FACTORY,
} as const;

export type MotionDuration = keyof typeof DURATION;
export type MotionDistance = keyof typeof DISTANCE;
