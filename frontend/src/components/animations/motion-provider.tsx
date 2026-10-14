"use client";

import type { ReactNode } from "react";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";

import { TRANSITION_BASE } from "@/lib/motion/tokens";

import { useMarkHydrated } from "./use-entrance";

/**
 * MotionProvider — envolve a aplicação uma única vez (app/layout.tsx).
 *
 * - `LazyMotion` + `domAnimation`: só o pacote de animações DOM (sem
 *   drag/layout) é carregado. Carregamento SÍNCRONO de propósito: com
 *   features assíncronas, um `m.*` montado antes do chunk chegar fica parado
 *   no estado `initial` (opacity 0) — conteúdo invisível (visto no e2e/axe).
 *   Use SEMPRE `m.*` (de "motion/react"), nunca `motion.*` — este último embute todas as features e anula a economia.
 *   `strict` não é ligado de propósito: um `motion.*` esquecido não deve
 *   derrubar a tela em produção (vira só custo de bundle, detectável no build).
 * - `MotionConfig reducedMotion="user"`: sob prefers-reduced-motion o Motion
 *   desliga animações de transform/layout automaticamente (opacity mantém).
 * - Transição padrão = tokens do DESIGN.md (tween 200ms, ease factory).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  useMarkHydrated();
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user" transition={TRANSITION_BASE}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
