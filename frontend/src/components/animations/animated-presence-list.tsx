"use client";

import type { ReactNode } from "react";
import { AnimatePresence, m, type HTMLMotionProps } from "motion/react";

import { fade } from "@/lib/motion/presets";

/**
 * Lista com saída animada (fade 150ms) de itens removidos. A entrada inicial
 * é suprimida (`initial={false}`): só itens ADICIONADOS depois animam.
 * Os filhos devem ser `<PresenceItem key=...>` com chaves estáveis.
 * Use apenas em listas curtas (toasts, filtros ativos, chips) — não em tabelas.
 */
export function AnimatedPresenceList({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

export type PresenceItemProps = Omit<
  HTMLMotionProps<"div">,
  "initial" | "animate" | "exit" | "variants"
>;

export function PresenceItem(props: PresenceItemProps) {
  return <m.div variants={fade} initial="hidden" animate="visible" exit="exit" {...props} />;
}
