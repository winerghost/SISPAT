"use client";

import type { ReactNode } from "react";
import { m } from "motion/react";

import { page } from "@/lib/motion/presets";

import { useEntranceInitial } from "./use-entrance";

/**
 * Transição de página (fade + 4px, 200ms). Usado por app/template.tsx.
 *
 * - Primeira carga (SSR + hidratação): `initial={false}` → o HTML do servidor
 *   NÃO contém opacity:0; o conteúdo é visível mesmo se o JS falhar.
 * - Navegação client-side: o template remonta e a página entra animada.
 * - Reduced motion: sem animação.
 * - Não move o foco nem cria elementos focáveis; após a animação o Motion
 *   deixa `transform: none` (sem containing block para elementos fixed).
 */
export function AnimatedPage({ children }: { children: ReactNode }) {
  const initial = useEntranceInitial();
  return (
    <m.div variants={page} initial={initial} animate="visible" data-animated-page="">
      {children}
    </m.div>
  );
}
