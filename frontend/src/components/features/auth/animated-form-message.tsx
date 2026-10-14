"use client";

import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/components/animations";
import { FormMessage } from "@/components/ui/form-message";
import { DISTANCE, TRANSITION_FAST } from "@/lib/motion/tokens";

// =============================================================================
// AnimatedFormMessage — FormMessage (role="alert"/"status") com entrada
// discreta: fade + 4px, 150ms; saída só fade.
// =============================================================================
// `mode="wait"` + `key` = texto: a mensagem nova só monta depois que a antiga
// saiu — nunca há dois elementos com o mesmo `id` (o campo continua com
// `aria-describedby` válido) e a mesma mensagem repetida é re-anunciada.
// Sob reduced motion não há deslocamento (só a troca).
// =============================================================================

export interface AnimatedFormMessageProps {
  message: string | null;
  id?: string;
  tone?: "error" | "success";
  surface?: "dark" | "light";
  /** Conteúdo alternativo (padrão: o próprio `message`). */
  children?: ReactNode;
}

export function AnimatedFormMessage({ message, id, tone, surface, children }: AnimatedFormMessageProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      {message && (
        <m.div
          key={message}
          initial={reduced ? false : { opacity: 0, y: -DISTANCE.sm }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={TRANSITION_FAST}
        >
          <FormMessage id={id} tone={tone} surface={surface}>
            {children ?? message}
          </FormMessage>
        </m.div>
      )}
    </AnimatePresence>
  );
}
