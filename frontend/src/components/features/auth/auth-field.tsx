import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Campo rotulado das telas de autenticação. O rótulo (eyebrow) acompanha o
 * foco do campo: pale-stone → bone em 150ms (transition-factory), junto com a
 * borda do Input — uma única "troca de estado", sem deslocamento.
 */
export function AuthField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("group flex flex-col gap-1.5", className)}>
      <span className="text-eyebrow text-pale-stone transition-factory group-focus-within:text-bone">
        {label}
      </span>
      {children}
    </label>
  );
}
