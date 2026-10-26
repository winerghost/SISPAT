"use client";

import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, m } from "motion/react";
import { X } from "lucide-react";

import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { TRANSITION_BASE, TRANSITION_FAST } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

// =============================================================================
// Sheet — painel lateral (direita) sobre Radix Dialog, no mesmo padrão do
// `mobile-nav`: foco preso, Esc fecha, foco devolvido ao gatilho, overlay com
// fade e painel deslizando por `transform` (200 ms entrada / 150 ms saída,
// ease factory, tween; sem deslocamento sob prefers-reduced-motion).
// Superfície escura (obsidian + hairline ash-stroke), sem sombra (DESIGN.md >
// Elevation). Largura total em telas pequenas (320px) e até 640px nas
// maiores; o próprio painel rola na vertical — nunca a página na horizontal.
// Diálogos de confirmação (Dialog claro) abertos de dentro dele ficam por cima.
// =============================================================================

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Selos/metadados logo abaixo do título (ex.: situação do registro). */
  meta?: ReactNode;
  /** Barra de ações fixa no rodapé do painel (sticky; fica sempre visível ao rolar). */
  footer?: ReactNode;
  /** Conteúdo do painel. */
  children: ReactNode;
  className?: string;
}

export function Sheet({ open, onOpenChange, title, description, meta, footer, children, className }: SheetProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-50 bg-obsidian-canvas/80"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: TRANSITION_BASE }}
                exit={{ opacity: 0, transition: TRANSITION_FAST }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              forceMount
              // Sem descrição: desliga o aria-describedby automático do Radix.
              {...(description ? {} : { "aria-describedby": undefined })}
            >
              <m.div
                data-sheet
                className={cn(
                  "fixed inset-y-0 right-0 z-50 flex w-full max-w-[40rem] flex-col overflow-y-auto overscroll-contain border-l border-ash-stroke bg-obsidian-canvas",
                  className,
                )}
                initial={{ transform: reduced ? "none" : "translateX(100%)" }}
                animate={{ transform: "translateX(0%)", transition: TRANSITION_BASE }}
                exit={{
                  transform: reduced ? "none" : "translateX(100%)",
                  transition: reduced ? { duration: 0 } : TRANSITION_FAST,
                }}
              >
                <div className="flex items-start justify-between gap-3 border-b border-ash-stroke px-4 py-4 sm:px-6">
                  <div className="flex min-w-0 flex-col gap-1">
                    <DialogPrimitive.Title className="break-words text-body text-bone [overflow-wrap:anywhere]">
                      {title}
                    </DialogPrimitive.Title>
                    {meta ? <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div> : null}
                    {description ? (
                      <DialogPrimitive.Description className="break-words text-body-sm text-warm-granite [overflow-wrap:anywhere]">
                        {description}
                      </DialogPrimitive.Description>
                    ) : null}
                  </div>
                  <DialogPrimitive.Close
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-buttons text-bone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
                    aria-label="Fechar painel"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </DialogPrimitive.Close>
                </div>
                <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6">{children}</div>
                {footer ? (
                  <div className="sticky bottom-0 z-10 border-t border-ash-stroke bg-obsidian-canvas px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
                    {footer}
                  </div>
                ) : null}
              </m.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
