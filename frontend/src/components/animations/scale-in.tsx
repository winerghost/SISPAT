"use client";

import { m, type HTMLMotionProps } from "motion/react";

import { scaleIn } from "@/lib/motion/presets";
import { TRANSITION_BASE } from "@/lib/motion/tokens";

import { useEntranceInitial } from "./use-entrance";

export interface ScaleInProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  delay?: number;
  disabled?: boolean;
}

/** Fade + escala discreta 0.98 → 1 (destaques pontuais; nunca em listas longas). */
export function ScaleIn({ delay = 0, disabled = false, transition, ...props }: ScaleInProps) {
  const initial = useEntranceInitial(!disabled);
  return (
    <m.div
      variants={scaleIn}
      initial={initial}
      animate="visible"
      exit="exit"
      transition={transition ?? { ...TRANSITION_BASE, delay }}
      {...props}
    />
  );
}
