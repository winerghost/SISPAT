import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

// =============================================================================
// StepIndicator — etapas de um fluxo (ex.: QR code → código → concluído).
// =============================================================================
// Voz de instrumento (Geist Mono 12px uppercase). Estado por forma + texto,
// não só cor: etapa atual com `aria-current="step"` e marcador bone; etapas
// concluídas com ✓ em metric-green (cor de status) + texto "concluída" para
// leitores de tela. Troca de cor em 150ms (transition-factory), sem
// deslocamento. Só reflete o estado REAL recebido por props.
// =============================================================================

export interface StepIndicatorProps {
  /** Nome acessível da lista (ex.: "Etapas da ativação do MFA"). */
  label: string;
  steps: string[];
  /** Índice da etapa atual (0-based). Use `steps.length` para "tudo concluído". */
  current: number;
  className?: string;
}

export function StepIndicator({ label, steps, current, className }: StepIndicatorProps) {
  return (
    <ol aria-label={label} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className="flex items-center gap-2 text-eyebrow"
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-full border font-mono text-caption tabular-nums transition-factory [&_svg]:size-3",
                done && "border-metric-green text-metric-green",
                active && "border-bone text-bone",
                !done && !active && "border-ash-stroke text-warm-granite",
              )}
            >
              {done ? <Check /> : index + 1}
            </span>
            <span
              className={cn(
                "transition-factory",
                active ? "text-bone" : done ? "text-pale-stone" : "text-warm-granite",
              )}
            >
              {step}
              {done && <span className="sr-only"> (concluída)</span>}
            </span>
            {index < steps.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-ash-stroke" />}
          </li>
        );
      })}
    </ol>
  );
}
