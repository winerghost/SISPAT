"use client";

import { useEffect, useState } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";

// =============================================================================
// Política de entrada "à prova de SSR"
// =============================================================================
// O Motion renderiza no HTML do servidor o estado `initial` (ex.: inline
// `opacity:0`). Se o JS falhar/demorar, o conteúdo SSR ficaria invisível.
// Por isso: tudo que monta DURANTE a hidratação inicial usa `initial={false}`
// (aparece já no estado final, idêntico no servidor e no cliente — sem
// mismatch). Só elementos montados DEPOIS da hidratação (navegação
// client-side, dados que chegaram, itens adicionados) animam a entrada.
// Sob prefers-reduced-motion a entrada é sempre suprimida.
// =============================================================================

let appHydrated = false;

/** Marca a hidratação inicial como concluída (chamado pelo MotionProvider). */
export function useMarkHydrated(): void {
  useEffect(() => {
    appHydrated = true;
  }, []);
}

/**
 * Retorna o valor para a prop `initial` de um `m.*`: `false` (sem animação
 * de entrada) durante a hidratação ou sob reduced motion; senão `"hidden"`.
 */
export function useEntranceInitial(enabled = true): false | "hidden" {
  // Avaliado uma única vez na montagem — `initial` só é lido na montagem.
  const [mountedAfterHydration] = useState(() => appHydrated);
  const reduced = usePrefersReducedMotion();
  if (!enabled || !mountedAfterHydration || reduced) return false;
  return "hidden";
}
