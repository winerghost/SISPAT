"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { AnimatedCounter } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { chartClasses, type ChartThemeName } from "./chart-theme";
import type { DashboardStat } from "./types";

// =============================================================================
// StatCard — "Metric Tile" do DESIGN.md: sem fundo, hairline carbon-lift,
// rótulo Geist Mono 12px uppercase pale-stone, valor Geist 36px peso 400 bone.
// O número conta de 0 até o valor REAL recebido por prop (AnimatedCounter:
// tween ≤ 320ms, valor final exato no HTML/leitor de tela, sem contagem sob
// reduced motion). `value === null` mostra "—" e "Sem dado" — nunca um
// número inventado.
// `delta` (variação REAL do backend): Badge com ícone + sinal + texto (nunca
// só cor); `null`/ausente = nenhum selo. Cores (tema "screen"/"paper") vêm de
// ./chart-theme.
// =============================================================================

export interface StatCardProps {
  stat: DashboardStat;
  /** Tema visual (padrão "screen"; "paper" = relatório impresso). */
  theme?: ChartThemeName;
  className?: string;
}

const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

function DeltaBadge({ delta, theme }: { delta: number; theme: ChartThemeName }) {
  const positive = delta > 0;
  const negative = delta < 0;
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Minus;
  const sign = positive ? "+" : negative ? "−" : "";
  const text = `${sign}${percent.format(Math.abs(delta))}%`;
  const spoken = positive ? "aumento" : negative ? "queda" : "sem variação";
  return (
    <Badge
      data-stat-delta
      variant={theme === "paper" ? "outline" : positive ? "success" : negative ? "warning" : "default"}
      // `font-mono text-[12px] uppercase`: voz "instrumento" explícita — o `cn` do Badge
      // descarta `text-eyebrow` quando a variante traz uma cor `text-*`.
      className={cn(
        "font-mono text-[12px] uppercase leading-none tracking-[-0.02em]",
        theme === "paper" && "border-graphite-mid text-obsidian-canvas",
      )}
    >
      <Icon aria-hidden="true" />
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{`${spoken} de ${percent.format(Math.abs(delta))}%`}</span>
    </Badge>
  );
}

export function StatCard({ stat, theme = "screen", className }: StatCardProps) {
  const { label, value, unit, decimals = 0, description, delta } = stat;
  const hasValue = value !== null && Number.isFinite(value);
  const cls = chartClasses(theme);
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);

  return (
    <div
      data-stat-card={stat.id}
      className={cn("flex min-w-0 flex-col gap-3 border p-5", cls.statBorder, className)}
    >
      <span className={cn("text-eyebrow", cls.statLabel)}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        {hasValue ? (
          // live="off": grades de números não devem disparar vários anúncios.
          <AnimatedCounter
            value={value}
            decimals={decimals}
            live="off"
            className={cn("break-all text-heading", cls.statValue)}
          />
        ) : (
          <span className={cn("text-heading", cls.statMuted)}>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Sem dado</span>
          </span>
        )}
        {hasValue && unit && <span className={cn("text-body-sm", cls.statMuted)}>{unit}</span>}
      </div>
      {hasValue && hasDelta && (
        <div>
          <DeltaBadge delta={delta} theme={theme} />
        </div>
      )}
      {description && <p className={cn("text-body-sm", cls.statMuted)}>{description}</p>}
    </div>
  );
}
