"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

import { FadeIn } from "@/components/animations";
import { cn } from "@/lib/utils";

// =============================================================================
// EmptyState — estado vazio "instrumento": borda hairline tracejada, ícone
// warm-granite, título bone, descrição warm-granite. Entrada fade 200ms (só
// quando monta após a hidratação; reduced motion → sem animação). Não usa
// heading (não interfere na hierarquia h1/h2 da página). Para tabelas, use
// dentro de uma <TableCell colSpan> (ver `TableEmpty` em ui/table.tsx).
// =============================================================================

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  /** "panel" (padrão): com borda; "plain": sem borda (ex.: dentro de tabela). */
  variant?: "panel" | "plain";
  className?: string;
  /**
   * Entrada por fade (padrão). Desligue onde o texto precisa estar com contraste
   * pleno desde o primeiro quadro (ex.: dentro de tabelas, recarregadas a cada
   * filtro) — durante o fade o contraste efetivo cai (WCAG 1.4.3).
   */
  animated?: boolean;
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  variant = "panel",
  className,
  animated = true,
}: EmptyStateProps) {
  return (
    <FadeIn
      disabled={!animated}
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center",
        variant === "panel" && "rounded-cards border border-dashed border-ash-stroke",
        className,
      )}
    >
      <Icon className="h-5 w-5 text-warm-granite" aria-hidden="true" />
      <p className="text-body-sm text-bone">{title}</p>
      {description ? (
        <p className="max-w-prose text-body-sm text-warm-granite">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </FadeIn>
  );
}
