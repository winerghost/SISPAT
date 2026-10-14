"use client";

import { m, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";
import { slideUp } from "@/lib/motion/presets";

import { useEntranceInitial } from "./use-entrance";

export interface AnimatedCardProps
  extends Omit<HTMLMotionProps<"div">, "initial" | "animate" | "variants"> {
  /** Hover/focus-within discreto (borda ash-stroke → pale-stone). */
  interactive?: boolean;
  /** Entrada fade + 8px ao montar após a hidratação (padrão true). */
  enter?: boolean;
  /**
   * "dark" (padrão): Feature Card — transparente, borda hairline.
   * "light": Light Surface Card — bg bone, texto obsidian.
   */
  surface?: "dark" | "light";
}

/**
 * Card do DESIGN.md com feedback de hover SOMENTE por cor de borda (CSS,
 * 150ms, ease factory) — sem lift, sombra, glow ou escala.
 */
export function AnimatedCard({
  interactive = false,
  enter = true,
  surface = "dark",
  className,
  ...props
}: AnimatedCardProps) {
  const initial = useEntranceInitial(enter);
  return (
    <m.div
      variants={slideUp}
      initial={initial}
      animate="visible"
      exit="exit"
      className={cn(
        "rounded-cards border p-card-padding transition-factory",
        surface === "dark"
          ? "border-ash-stroke bg-transparent text-bone"
          : "border-transparent bg-bone text-obsidian-canvas",
        interactive &&
          (surface === "dark"
            ? "hover:border-pale-stone focus-within:border-pale-stone"
            : "hover:border-graphite-mid focus-within:border-graphite-mid"),
        className,
      )}
      {...props}
    />
  );
}
