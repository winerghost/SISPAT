import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

// =============================================================================
// FormMessage — mensagem de erro/sucesso de formulário, acessível.
// =============================================================================
// - `role="alert"` (erro) / `role="status"` (sucesso): anunciada por leitores
//   de tela assim que aparece (WCAG 4.1.3 Status Messages); passe `id` e use
//   `aria-describedby` no campo relacionado (WCAG 3.3.1).
// - Superfície escura (padrão): texto signal-orange (5.7:1 sobre #101010).
// - Superfície clara (`surface="light"`, ex.: Dialog bg-bone): signal-orange
//   sobre bone tem só 2.9:1 — então o texto fica obsidian e o laranja vira o
//   "Status Pulse" de 6px (DESIGN.md: laranja é voz de estado, não texto).
// =============================================================================

interface FormMessageProps extends HTMLAttributes<HTMLParagraphElement> {
  tone?: "error" | "success";
  surface?: "dark" | "light";
}

export function FormMessage({
  tone = "error",
  surface = "dark",
  className,
  children,
  ...props
}: FormMessageProps) {
  const dotColor = tone === "error" ? "bg-signal-orange" : "bg-metric-green";
  const textColor =
    surface === "light"
      ? "text-obsidian-canvas"
      : tone === "error"
        ? "text-signal-orange"
        : "text-metric-green";

  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2 text-body-sm", textColor, className)}
      {...props}
    >
      {surface === "light" && (
        <span className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} aria-hidden />
      )}
      <span>{children}</span>
    </p>
  );
}
