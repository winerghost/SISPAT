import type { Transition, Variants } from "motion/react";

import {
  DISTANCE,
  DURATION,
  EASE_FACTORY,
  SCALE_IN_FROM,
  STAGGER,
  TRANSITION_BASE,
  TRANSITION_FAST,
} from "./tokens";

// =============================================================================
// Presets (variants) do Motion — todos com rótulos "hidden" / "visible" /
// "exit". Animam SOMENTE opacity e transform (GPU, sem layout shift).
// =============================================================================

export type PresetName = "fade" | "slideUp" | "scaleIn" | "page";

/** Fade puro — o preset mais seguro (também usado sob reduced motion). */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: TRANSITION_BASE },
  exit: { opacity: 0, transition: TRANSITION_FAST },
};

/** Fade + deslocamento vertical pequeno (8px por padrão). */
export function slideUpVariants(distance: number = DISTANCE.md): Variants {
  return {
    hidden: { opacity: 0, y: distance },
    visible: { opacity: 1, y: 0, transition: TRANSITION_BASE },
    exit: { opacity: 0, y: -Math.min(distance, DISTANCE.sm), transition: TRANSITION_FAST },
  };
}
export const slideUp: Variants = slideUpVariants();

/** Escala discreta 0.98 → 1 (modais, popovers, cards destacados). */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: SCALE_IN_FROM },
  visible: { opacity: 1, scale: 1, transition: TRANSITION_BASE },
  exit: { opacity: 0, scale: SCALE_IN_FROM, transition: TRANSITION_FAST },
};

/** Transição de página: fade + 4px. Sem exit (App Router não anima saída). */
export const page: Variants = {
  hidden: { opacity: 0, y: DISTANCE.sm },
  visible: { opacity: 1, y: 0, transition: TRANSITION_BASE },
};

export const PRESETS: Record<PresetName, Variants> = { fade, slideUp, scaleIn, page };

/** Variante equivalente sem deslocamento/escala (prefers-reduced-motion). */
export const reducedFade: Variants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0 } },
};

/**
 * Container de stagger. O atraso de cada item é limitado a `maxItems`
 * intervalos (ver `staggerItemDelay`), evitando cascatas longas em listas.
 */
export const staggerContainer: Variants = {
  // Só propaga os rótulos; o atraso de cada item vem via `custom`
  // (staggerItemDelay), o que permite saturar no N-ésimo item.
  hidden: {},
  visible: {},
  exit: {},
};

/** Atraso (s) de um item de índice `index`, saturado em `maxItems`. */
export function staggerItemDelay(
  index: number,
  interval: number = STAGGER.interval,
  maxItems: number = STAGGER.maxItems,
): number {
  if (index < 0 || index >= maxItems) return 0;
  return index * interval;
}

/** Item de stagger: fade + 4px, atraso recebido em `custom` (segundos). */
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: DISTANCE.sm },
  visible: (delay: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { ...TRANSITION_BASE, delay },
  }),
  exit: { opacity: 0, transition: TRANSITION_FAST },
};

/** Hover de card: só cor de borda (CSS), sem lift. Exposto p/ consistência. */
export const cardHoverTransition: Transition = {
  type: "tween",
  duration: DURATION.fast,
  ease: EASE_FACTORY,
};
