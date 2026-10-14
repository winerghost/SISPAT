"use client";

import type { ComponentProps } from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

/**
 * Toaster — wrapper sobre `sonner`, temizado para o canvas escuro do
 * Factory: toast como "Dark Filled Button" (carbon-lift bg, bone texto,
 * borda ash-stroke, raio 3px), sem sombra.
 * Motion: entrada/saída da lib ajustadas para 200ms + ease factory em
 * globals.css (seletor [data-sonner-toast]); o sonner já zera as
 * transições sob prefers-reduced-motion. `aria-live` é gerido pela lib.
 */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast bg-carbon-lift text-bone border border-ash-stroke rounded-buttons shadow-none font-sans text-body-sm",
          description: "text-warm-granite",
          actionButton: "bg-bone text-obsidian-canvas rounded-buttons",
          cancelButton: "bg-transparent text-warm-granite",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
