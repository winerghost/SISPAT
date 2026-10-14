"use client";

import { AnimatedCounter } from "@/components/animations";
import { cn } from "@/lib/utils";

import type { DashboardStat } from "./types";

// =============================================================================
// StatCard — "Metric Tile" do DESIGN.md: sem fundo, hairline carbon-lift,
// rótulo Geist Mono 12px uppercase pale-stone, valor Geist 36px peso 400 bone.
// O número conta de 0 até o valor REAL recebido por prop (AnimatedCounter:
// tween ≤ 320ms, valor final exato no HTML/leitor de tela, sem contagem sob
// reduced motion). `value === null` mostra "—" e "Sem dado" — nunca um
// número inventado.
// =============================================================================

export interface StatCardProps {
  stat: DashboardStat;
  className?: string;
}

export function StatCard({ stat, className }: StatCardProps) {
  const { label, value, unit, decimals = 0, description } = stat;
  const hasValue = value !== null && Number.isFinite(value);

  return (
    <div
      data-stat-card={stat.id}
      className={cn("flex min-w-0 flex-col gap-3 border border-carbon-lift p-5", className)}
    >
      <span className="text-eyebrow text-pale-stone">{label}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        {hasValue ? (
          // live="off": grades de números não devem disparar vários anúncios.
          <AnimatedCounter value={value} decimals={decimals} live="off" className="text-heading text-bone" />
        ) : (
          <span className="text-heading text-warm-granite">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Sem dado</span>
          </span>
        )}
        {hasValue && unit && <span className="text-body-sm text-warm-granite">{unit}</span>}
      </div>
      {description && <p className="text-body-sm text-warm-granite">{description}</p>}
    </div>
  );
}
