"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

// =============================================================================
// Switch — checkbox NATIVO com role="switch" (sem dependência nova, ver plano
// A10). O próprio <input> é o alvo (44x24px, WCAG 2.5.8) e recebe o foco
// visível (anel bone); o "polegar" é decorativo (aria-hidden) e desliza por
// transform em 150ms (desligado sob prefers-reduced-motion).
// Raios de 3px (DESIGN.md: o sistema "não é macio"); metric-green só no
// polegar/borda quando ligado — nunca como fill grande. Estado nunca só por
// cor: a posição do polegar também muda.
// <label htmlFor> dá o nome acessível; a descrição entra em aria-describedby.
// =============================================================================

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  id,
  className,
}: SwitchProps) {
  const autoId = useId();
  const controlId = id ?? `switch-${autoId.replace(/:/g, "")}`;
  const descriptionId = `${controlId}-descricao`;

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span className="relative inline-flex h-6 w-11 shrink-0">
        <input
          id={controlId}
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onCheckedChange(event.target.checked)}
          className={cn(
            "peer absolute inset-0 h-6 w-11 cursor-pointer appearance-none rounded-sm border border-ash-stroke bg-carbon-lift transition-factory",
            "hover:border-graphite-mid checked:border-metric-green/60",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-[2px] bg-warm-granite",
            "transition-[transform,background-color] duration-fast ease-factory motion-reduce:transition-none",
            "peer-checked:translate-x-5 peer-checked:bg-metric-green peer-disabled:opacity-50",
          )}
        />
      </span>
      <div className="flex min-w-0 flex-col gap-1 pt-0.5">
        <label
          htmlFor={controlId}
          className={cn("text-body-sm text-bone", disabled ? "cursor-not-allowed" : "cursor-pointer")}
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-caption leading-[1.4] text-warm-granite">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
