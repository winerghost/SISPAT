"use client";

import { useMemo } from "react";
import { m, type HTMLMotionProps } from "motion/react";

import { slideUpVariants } from "@/lib/motion/presets";
import { DISTANCE, TRANSITION_BASE, type MotionDistance } from "@/lib/motion/tokens";

import { useEntranceInitial } from "./use-entrance";

export interface SlideInProps extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  /** "sm" = 4px, "md" = 8px (padrão). Valores maiores são limitados a 8px. */
  distance?: MotionDistance | number;
  /** "up" (padrão): entra de baixo para cima; "down": de cima para baixo. */
  direction?: "up" | "down";
  delay?: number;
  disabled?: boolean;
}

/** Fade + deslocamento vertical curto (4–8px). Nunca horizontal/parallax. */
export function SlideIn({
  distance = "md",
  direction = "up",
  delay = 0,
  disabled = false,
  transition,
  ...props
}: SlideInProps) {
  const initial = useEntranceInitial(!disabled);
  const px = Math.min(typeof distance === "number" ? distance : DISTANCE[distance], DISTANCE.md);
  const variants = useMemo(
    () => slideUpVariants(direction === "up" ? px : -px),
    [px, direction],
  );
  return (
    <m.div
      variants={variants}
      initial={initial}
      animate="visible"
      exit="exit"
      transition={transition ?? { ...TRANSITION_BASE, delay }}
      {...props}
    />
  );
}
