import { cn } from "@/lib/utils";

import { Skeleton } from "./skeleton";

export interface LoadingSkeletonProps {
  /** "table": linhas de tabela; "cards": grade de cards; "lines": parágrafo. */
  variant?: "table" | "cards" | "lines";
  /** Linhas (table/lines) ou cards (cards). Limitado a 12 — é só um esboço. */
  count?: number;
  /** Colunas da variante table (padrão 4). */
  columns?: number;
  /** Texto anunciado a leitores de tela (padrão "Carregando…"). */
  label?: string;
  className?: string;
}

/**
 * Esboço de carregamento com dimensões estáveis (evita layout shift quando
 * os dados reais chegam). Anuncia o estado via role="status"; os blocos são
 * decorativos (aria-hidden). Nunca simula dados/progresso.
 */
export function LoadingSkeleton({
  variant = "lines",
  count = 3,
  columns = 4,
  label = "Carregando…",
  className,
}: LoadingSkeletonProps) {
  const n = Math.max(1, Math.min(count, 12));
  const items = Array.from({ length: n }, (_, i) => i);

  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn("w-full", className)}>
      <span className="sr-only">{label}</span>
      {variant === "table" && (
        <div className="flex flex-col gap-0 rounded-cards border border-ash-stroke">
          {items.map((row) => (
            <div
              key={row}
              className="grid gap-4 border-b border-carbon-lift px-4 py-3 last:border-b-0"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: Math.max(1, columns) }, (_, c) => (
                <Skeleton key={c} className={cn("h-4", c === 0 ? "w-3/4" : "w-1/2")} />
              ))}
            </div>
          ))}
        </div>
      )}
      {variant === "cards" && (
        <div className="grid grid-cols-1 gap-element-gap sm:grid-cols-2 lg:grid-cols-3">
          {items.map((card) => (
            <div
              key={card}
              className="flex flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-9 w-1/2" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      )}
      {variant === "lines" && (
        <div className="flex flex-col gap-2">
          {items.map((line) => (
            <Skeleton key={line} className={cn("h-4", line === n - 1 ? "w-2/3" : "w-full")} />
          ))}
        </div>
      )}
    </div>
  );
}
