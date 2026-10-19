"use client";

import { AlertOctagon, AlertTriangle, Info, RefreshCw, type LucideIcon } from "lucide-react";

import { FadeIn, StaggerContainer, StaggerItem } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import {
  useDashboardAlerts,
  type AlertSeverity,
  type DashboardAlert,
  type DashboardAlerts,
} from "@/lib/alerts-api";
import { cn } from "@/lib/utils";

// =============================================================================
// Widget "Alertas patrimoniais" (Home). Alertas DETERMINÍSTICOS vindos do
// backend — funciona integralmente sem recursos opcionais.
// - Severidade = ícone + texto (nunca só cor); cores funcionais só em
//   ícone/texto, nunca fill (DESIGN.md).
// - Textos e números exatamente como o backend enviou, como texto puro
//   (escapado pelo React; sem HTML/markdown).
// - Estados: carregando, vazio, erro (com nova tentativa) e parcial.
// =============================================================================

const SEVERITY: Record<AlertSeverity, { label: string; Icon: LucideIcon; tone: string; rank: number }> = {
  critical: { label: "Crítico", Icon: AlertOctagon, tone: "text-signal-orange", rank: 0 },
  warning: { label: "Atenção", Icon: AlertTriangle, tone: "text-signal-orange", rank: 1 },
  info: { label: "Informação", Icon: Info, tone: "text-pale-stone", rank: 2 },
};

/** Ordena só a exibição (críticos primeiro); mantém a ordem do backend no empate. */
export function sortAlerts(items: DashboardAlert[]): DashboardAlert[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY[a.item.severity].rank - SEVERITY[b.item.severity].rank || a.index - b.index)
    .map(({ item }) => item);
}

function formatGeneratedAt(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Araguaina",
  }).format(date);
}

function AlertContent({ alert }: { alert: DashboardAlert }) {
  const { label, Icon, tone } = SEVERITY[alert.severity];
  return (
    <>
      <div className="flex min-w-0 flex-col gap-2">
        <span className={cn("inline-flex items-center gap-2 text-eyebrow", tone)}>
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {label}
        </span>
        <h3 className="break-words text-body text-bone">{alert.title}</h3>
        {alert.description ? (
          <p className="max-w-prose whitespace-pre-wrap break-words text-body-sm text-warm-granite">
            {alert.description}
          </p>
        ) : null}
      </div>
      <p className="flex shrink-0 items-baseline gap-2 sm:flex-col sm:items-end sm:gap-1">
        <span className="text-heading text-bone" data-alert-count>
          {alert.count}
        </span>
        <span className="text-eyebrow text-pale-stone">{alert.count === 1 ? "ocorrência" : "ocorrências"}</span>
      </p>
    </>
  );
}

function PartialNotice({ codes }: { codes: string[] }) {
  const plural = codes.length !== 1;
  return (
    <div
      role="status"
      data-alerts-partial
      className="flex items-start gap-2 border-b border-carbon-lift px-4 py-3 text-body-sm text-warm-granite sm:px-6"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
      <p className="break-words">
        Resultado parcial: {plural ? `${codes.length} verificações não puderam` : "1 verificação não pôde"} ser
        calculada{plural ? "s" : ""} agora ({codes.join(", ")}). Os demais alertas estão corretos.
      </p>
    </div>
  );
}

function AlertsBody({ data }: { data: DashboardAlerts }) {
  const items = sortAlerts(data.items);
  const partial = data.unavailable.length > 0;
  return (
    <>
      {partial ? <PartialNotice codes={data.unavailable} /> : null}
      {items.length === 0 ? (
        <div className="p-4 sm:p-6">
          <EmptyState
            title="Nenhum alerta"
            description={
              partial
                ? "Algumas verificações estão indisponíveis; não é possível afirmar que está tudo em ordem."
                : "Nenhuma pendência patrimonial detectada nas verificações atuais."
            }
          />
        </div>
      ) : (
        <StaggerContainer as="ul" className="m-0 list-none p-0" aria-label="Lista de alertas patrimoniais">
          {items.map((alert, index) => (
            <StaggerItem
              as="li"
              key={`${alert.code}:${alert.title}:${index}`}
              index={index}
              data-severity={alert.severity}
              className="flex flex-col gap-3 border-b border-carbon-lift px-4 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:px-6"
            >
              <AlertContent alert={alert} />
            </StaggerItem>
          ))}
        </StaggerContainer>
      )}
    </>
  );
}

export function AlertsWidget({ className }: { className?: string }) {
  const query = useDashboardAlerts();
  const generatedAt = query.data ? formatGeneratedAt(query.data.generated_at) : null;

  return (
    <section
      aria-labelledby="alertas-patrimoniais"
      data-alerts-widget
      className={cn("overflow-hidden rounded-cards border border-ash-stroke", className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-carbon-lift px-4 py-3 sm:px-6">
        <h2 id="alertas-patrimoniais" className="text-eyebrow text-bone">
          Alertas patrimoniais
        </h2>
        {generatedAt ? <span className="text-eyebrow text-pale-stone">Atualizado em {generatedAt}</span> : null}
      </header>

      {query.isPending ? (
        <div className="p-4 sm:p-6">
          <LoadingSkeleton variant="lines" count={3} label="Carregando alertas patrimoniais" />
        </div>
      ) : query.isError ? (
        <FadeIn role="alert" className="flex flex-col items-start gap-3 p-4 sm:p-6">
          <p className="flex items-center gap-2 text-body-sm text-bone">
            <AlertTriangle className="h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            Não foi possível carregar os alertas patrimoniais.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()} loading={query.isFetching}>
            <RefreshCw aria-hidden="true" />
            Tentar novamente
          </Button>
        </FadeIn>
      ) : (
        <AlertsBody data={query.data} />
      )}
    </section>
  );
}
