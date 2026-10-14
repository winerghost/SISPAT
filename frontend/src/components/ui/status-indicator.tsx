import type { HTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Check, Circle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

// =============================================================================
// StatusIndicator — "Status Pulse" do DESIGN.md aplicado a estado de
// requisição/conexão: ícone + texto (nunca só cor), Geist Mono 12px uppercase.
// - idle    → círculo vazado warm-granite
// - loading → spinner bone (`animate-spin-slow`, desligado em reduced motion)
// - success → check metric-green
// - warning / error → triângulo signal-orange
// Cores funcionais só no ícone/texto, nunca como fill (DESIGN.md > Don't).
// Deve refletir APENAS o estado real da query/mutation — nunca progresso
// simulado. `role="status"` + `aria-live="polite"`: a troca de rótulo é
// anunciada sem interromper o leitor de tela.
// =============================================================================

export type StatusIndicatorState = "idle" | "loading" | "success" | "warning" | "error";

const TONE: Record<StatusIndicatorState, string> = {
  idle: "text-warm-granite",
  loading: "text-bone",
  success: "text-metric-green",
  warning: "text-signal-orange",
  error: "text-signal-orange",
};

function StatusIcon({ state }: { state: StatusIndicatorState }): ReactNode {
  const common = "h-3.5 w-3.5 shrink-0";
  switch (state) {
    case "loading":
      return <Loader2 className={cn(common, "animate-spin-slow")} aria-hidden="true" />;
    case "success":
      return <Check className={common} aria-hidden="true" />;
    case "warning":
    case "error":
      return <AlertTriangle className={common} aria-hidden="true" />;
    default:
      return <Circle className={common} aria-hidden="true" />;
  }
}

export interface StatusIndicatorProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  state: StatusIndicatorState;
  /** Texto visível do estado (o que é anunciado). */
  label: string;
  /** Prefixo opcional (ex.: "Planilha"), em pale-stone. */
  prefix?: string;
  /** `false` quando o pai já é uma região live (evita anúncio duplo). */
  live?: boolean;
}

export function StatusIndicator({
  state,
  label,
  prefix,
  live = true,
  className,
  ...props
}: StatusIndicatorProps) {
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      data-state={state}
      className={cn(
        "inline-flex min-h-6 items-center gap-2 text-eyebrow transition-factory",
        TONE[state],
        className,
      )}
      {...props}
    >
      <StatusIcon state={state} />
      {prefix ? <span className="text-pale-stone">{prefix}</span> : null}
      <span>{label}</span>
    </div>
  );
}
