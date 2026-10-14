"use client";

import { m, type HTMLMotionProps } from "motion/react";

import { fade } from "@/lib/motion/presets";
import { TRANSITION_BASE } from "@/lib/motion/tokens";

import { useEntranceInitial } from "./use-entrance";

export interface FadeInProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  /** Atraso em segundos (use com parcimônia; máx. recomendado 0.1). */
  delay?: number;
  /** Desliga a animação mantendo o wrapper (útil em renderização condicional). */
  disabled?: boolean;
}

/** Entrada por opacidade (200ms, ease factory). Sem deslocamento. */
export function FadeIn({ delay = 0, disabled = false, transition, ...props }: FadeInProps) {
  const initial = useEntranceInitial(!disabled);
  return (
    <m.div
      variants={fade}
      initial={initial}
      animate="visible"
      exit="exit"
      transition={transition ?? { ...TRANSITION_BASE, delay }}
      {...props}
    />
  );
}
