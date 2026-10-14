"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, m } from "motion/react";
import { Menu, X } from "lucide-react";

import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { TRANSITION_BASE, TRANSITION_FAST } from "@/lib/motion/tokens";
import { SidebarNav } from "./sidebar";

// =============================================================================
// MobileNav — menu de navegação para viewports < lg (1024px).
// =============================================================================
// Gaveta lateral sobre Radix Dialog (foco preso, Esc fecha, foco devolvido ao
// botão de abertura). Superfície "Carbon Lift" com hairline ash-stroke, sem
// sombra (DESIGN.md > Elevation) — o mesmo tratamento da sidebar desktop.
// Alvos de toque >= 36px (WCAG 2.5.8 exige >= 24px).
//
// Movimento: gaveta desliza da esquerda (transform, 200ms na entrada / 150ms
// na saída, ease factory, tween) e o overlay faz fade. Anima a propriedade
// `transform` inteira (não `x`) para o Motion usar WAAPI: a animação fica
// visível em `document.getAnimations()` e o `waitForAnimations` dos testes a
// espera antes de medir layout/contraste. `forceMount` +
// AnimatePresence mantêm o Radix montado durante a saída; ao desmontar, o
// FocusScope do Radix devolve o foco ao gatilho (comportamento inalterado).
// Sob prefers-reduced-motion não há deslocamento — só o fade do overlay.
// =============================================================================

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const reduced = usePrefersReducedMotion();

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-buttons border border-ash-stroke text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas lg:hidden"
        aria-label="Abrir menu de navegação"
      >
        <Menu className="h-4 w-4" aria-hidden />
      </DialogPrimitive.Trigger>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-50 bg-obsidian-canvas/80 lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: TRANSITION_BASE }}
                exit={{ opacity: 0, transition: TRANSITION_FAST }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                data-mobile-drawer
                className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-ash-stroke bg-carbon-lift lg:hidden"
                initial={{ transform: reduced ? "none" : "translateX(-100%)" }}
                animate={{ transform: "translateX(0%)", transition: TRANSITION_BASE }}
                exit={{
                  transform: reduced ? "none" : "translateX(-100%)",
                  transition: reduced ? { duration: 0 } : TRANSITION_FAST,
                }}
              >
                <div className="flex h-16 shrink-0 items-center justify-between border-b border-ash-stroke px-4">
                  <DialogPrimitive.Title className="text-eyebrow text-bone">SISPAT-AGU</DialogPrimitive.Title>
                  <DialogPrimitive.Close
                    className="inline-flex h-9 w-9 items-center justify-center rounded-buttons text-bone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
                    aria-label="Fechar menu de navegação"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </DialogPrimitive.Close>
                </div>
                <SidebarNav
                  label="Navegação principal (menu móvel)"
                  className="flex-1 overflow-y-auto px-3 py-4"
                  onNavigate={() => setOpen(false)}
                />
              </m.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
