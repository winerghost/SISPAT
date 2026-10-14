"use client";

import { createContext, useContext } from "react";
import { m, type HTMLMotionProps } from "motion/react";

import { staggerContainer, staggerItem, staggerItemDelay } from "@/lib/motion/presets";
import { STAGGER } from "@/lib/motion/tokens";

import { useEntranceInitial } from "./use-entrance";

interface StaggerContextValue {
  /** `false` quando a entrada está suprimida (hidratação / reduced motion). */
  animate: boolean;
  interval: number;
  limit: number;
}

const StaggerContext = createContext<StaggerContextValue>({
  animate: false,
  interval: STAGGER.interval,
  limit: STAGGER.maxItems,
});

type ContainerTag = "div" | "ul" | "ol" | "tbody";

export interface StaggerContainerProps
  extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  /** Elemento renderizado (padrão "div"). Use "ul"/"ol" para listas. */
  as?: ContainerTag;
  /** Só os primeiros N itens animam (padrão 12; máximo 20). */
  limit?: number;
  /** Intervalo entre itens em segundos (padrão 0.03). */
  interval?: number;
  disabled?: boolean;
}

/**
 * Container de entrada escalonada. Itens com `index >= limit` aparecem
 * imediatamente (sem animação) — nunca anima centenas de linhas.
 */
export function StaggerContainer({
  as = "div",
  limit = STAGGER.maxItems,
  interval = STAGGER.interval,
  disabled = false,
  ...props
}: StaggerContainerProps) {
  const initial = useEntranceInitial(!disabled);
  const Comp = m[as] as typeof m.div;
  return (
    <StaggerContext.Provider
      value={{ animate: initial !== false, interval, limit: Math.min(limit, 20) }}
    >
      <Comp variants={staggerContainer} initial={initial} animate="visible" {...props} />
    </StaggerContext.Provider>
  );
}

type ItemTag = "div" | "li" | "tr";

export interface StaggerItemProps
  extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants" | "custom"> {
  /** Posição do item na lista (0-based) — define o atraso. */
  index: number;
  as?: ItemTag;
}

/** Item de StaggerContainer: fade + 4px com atraso saturado. */
export function StaggerItem({ index, as = "div", ...props }: StaggerItemProps) {
  const ctx = useContext(StaggerContext);
  const Comp = m[as] as typeof m.div;
  if (!ctx.animate || index >= ctx.limit) {
    // Fora do limite: renderiza no estado final, sem participar da animação.
    return <Comp initial={false} {...props} />;
  }
  return (
    <Comp
      variants={staggerItem}
      custom={staggerItemDelay(index, ctx.interval, ctx.limit)}
      {...props}
    />
  );
}
