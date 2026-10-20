"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { cn } from "@/lib/utils";

import dynamic from "next/dynamic";

// Nivo (gráficos) só é baixado quando há dados para um gráfico; o estado
// vazio do dashboard não paga esse custo (Core Web Vitals / mobile).
const AnimatedChart = dynamic(
  () => import("./animated-chart").then((mod) => mod.AnimatedChart),
  { ssr: false, loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" /> },
);
import { DashboardEmptyState } from "./dashboard-empty-state";
import { StatCard } from "./stat-card";
import type {
  DashboardChart,
  DashboardData,
  DashboardPeriodOption,
  DashboardStatus,
} from "./types";

// =============================================================================
// DashboardOverview — "Dashboard Frame" do DESIGN.md (painel #0d0d0d-like
// sobre o canvas, raio 10px, barra de título Geist Mono 12px com ponto de
// status) contendo a grade de Metric Tiles e os gráficos.
//
// Movimento: o frame usa `animate-dashboard-frame-in` (sfDashboardFrameIn —
// a ÚNICA entrada nomeada do sistema, aplicada uma vez aqui); os tiles entram
// em sequência (StaggerContainer, ≤ 12 itens) só quando os dados chegam
// depois da hidratação.
//
// Dados: SEMPRE por props. Hoje não existe endpoint de indicadores, então a
// página passa `status="unavailable"` e o painel mostra o estado vazio
// honesto. Skeleton só com `status="loading"` (consulta real). Filtro de
// período só é renderizado quando há dados E opções reais.
// =============================================================================

export interface DashboardOverviewProps {
  status: DashboardStatus;
  data?: DashboardData | null;
  /** Opções de período vindas do backend; sem dados → nenhum controle. */
  periodOptions?: DashboardPeriodOption[];
  period?: string;
  onPeriodChange?: (value: string) => void;
  className?: string;
}

const STATUS_LABEL: Record<DashboardStatus, string> = {
  unavailable: "Aguardando dados",
  loading: "Carregando",
  error: "Falha na consulta",
  ready: "Dados do backend",
};

export function DashboardOverview({
  status,
  data,
  periodOptions,
  period,
  onPeriodChange,
  className,
}: DashboardOverviewProps) {
  const ready = status === "ready" && !!data && data.stats.length + (data.charts?.length ?? 0) > 0;
  const showPeriods = ready && !!periodOptions?.length && !!onPeriodChange;

  return (
    <section
      aria-labelledby="painel-indicadores"
      data-dashboard-frame
      className={cn(
        "animate-dashboard-frame-in overflow-hidden rounded-cards border border-carbon-lift bg-[#0d0d0d]",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-carbon-lift px-5 py-3">
        {/* Chrome de janela (decorativo, neutro — sem cores fora da paleta). */}
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-ash-stroke" />
          <span className="h-2 w-2 rounded-full bg-ash-stroke" />
          <span className="h-2 w-2 rounded-full bg-ash-stroke" />
        </span>
        <h2 id="painel-indicadores" className="text-eyebrow text-bone">
          Painel patrimonial
        </h2>
        <span className="ml-auto flex items-center gap-2 text-eyebrow text-pale-stone">
          {/* Ponto signal-orange só para dado "vivo" (DESIGN.md > Status Pulse). */}
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 rounded-full", ready ? "bg-signal-orange" : "bg-warm-granite")}
          />
          {STATUS_LABEL[ready ? "ready" : status === "ready" ? "unavailable" : status]}
        </span>
      </header>

      {showPeriods && (
        <div role="group" aria-label="Período" className="flex flex-wrap gap-2 border-b border-carbon-lift px-5 py-3">
          {periodOptions!.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={opt.value === period}
              onClick={() => onPeriodChange!(opt.value)}
              className={cn(
                "inline-flex h-8 items-center rounded-buttons border px-3 text-caption transition-factory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
                opt.value === period
                  ? "border-bone text-bone"
                  : "border-ash-stroke text-warm-granite hover:border-chalk hover:text-chalk",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {status === "loading" && (
        <div className="p-5">
          <LoadingSkeleton variant="cards" count={4} label="Carregando indicadores…" />
        </div>
      )}

      {status === "error" && (
        <DashboardEmptyState
          title="Não foi possível carregar os indicadores"
          description="A consulta ao backend falhou. Tente novamente em instantes; nenhum valor foi estimado."
        />
      )}

      {(status === "unavailable" || (status === "ready" && !ready)) && (
        <DashboardEmptyState
          action={
            // Ações REAIS (telas existentes para todos os perfis). Também garantem
            // conteúdo focável no <main> rolável (axe scrollable-region-focusable).
            <div className="flex flex-col items-start gap-3">
            <Link
              href="/dashboard"
              className="group inline-flex min-h-6 items-center gap-2 rounded-nav text-body-sm text-bone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
            >
              Ver o dashboard completo
              <ArrowRight
                aria-hidden
                className="h-4 w-4 transition-transform duration-fast ease-factory group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
              />
            </Link>
            <Link
              href="/configuracoes/seguranca"
              className="group inline-flex min-h-6 items-center gap-2 rounded-nav text-body-sm text-bone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
            >
              Enquanto isso, revise a segurança da sua conta
              <ArrowRight
                aria-hidden
                className="h-4 w-4 transition-transform duration-fast ease-factory group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
              />
            </Link>
            </div>
          }
        />
      )}

      {ready && data && (
        <div className="flex flex-col">
          {data.stats.length > 0 && (
            <StaggerContainer
              as="ul"
              limit={12}
              aria-label="Indicadores"
              className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
            >
              {data.stats.map((stat, i) => (
                <StaggerItem as="li" key={stat.id} index={i} className="min-w-0">
                  <StatCard stat={stat} className="h-full border-0 border-b border-r" />
                </StaggerItem>
              ))}
            </StaggerContainer>
          )}
          {!!data.charts?.length && (
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
              {data.charts.map((chart) => (
                <SelectableChart key={chart.id} chart={chart} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SelectableChart({ chart }: { chart: DashboardChart }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <AnimatedChart
      kind={chart.kind}
      title={chart.title}
      description={chart.description}
      data={chart.data}
      valueLabel={chart.valueLabel}
      selectedKey={selected}
      onSelectKey={setSelected}
      className="border-0 border-b border-r"
    />
  );
}
