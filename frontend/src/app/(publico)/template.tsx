import type { ReactNode } from "react";

import { AnimatedPage } from "@/components/animations/animated-page";

// =============================================================================
// Template raiz — remonta a cada navegação (diferente do layout), o que
// dispara a entrada da página (fade + 4px, 200ms) em navegações client-side.
// A primeira carga NÃO anima (HTML do SSR já visível, sem opacity:0 inline;
// ver components/animations/use-entrance.ts). Foco/skip link intocados: o
// <main id="conteudo"> continua no layout, fora deste wrapper.
// =============================================================================

export default function Template({ children }: { children: ReactNode }) {
  return <AnimatedPage>{children}</AnimatedPage>;
}
