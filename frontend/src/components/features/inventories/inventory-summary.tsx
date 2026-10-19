"use client";

import { useQuery } from "@tanstack/react-query";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { getInventorySummary } from "@/lib/inventories-api";
import { CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { inventoryListErrorMessage, inventorySummaryKey } from "./inventory-labels";

// =============================================================================
// Resumo do inventário (`GET /inventories/<id>/summary`). TODOS os números e o
// percentual são calculados no SERVIDOR; a tela só os exibe (nunca soma, estima ou
// anima valores). A barra reflete exatamente `progress_percent` recebido, sem
// transição de largura. O total considera os bens não excluídos da unidade no
// momento da consulta (pode mudar se bens forem cadastrados ou excluídos).
// =============================================================================

function Metric({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-carbon-lift px-1 py-3" data-testid={testId}>
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="text-heading text-bone">{value}</dd>
    </div>
  );
}

export function InventorySummaryPanel({ inventoryId }: { inventoryId: string }) {
  const summary = useQuery({
    queryKey: inventorySummaryKey(inventoryId),
    queryFn: () => getInventorySummary(inventoryId),
    retry: noClientRetry,
  });

  if (summary.isPending) return <LoadingSkeleton variant="lines" count={3} label="Carregando resumo…" />;
  if (summary.isError) {
    return (
      <CatalogNotice onRetry={() => summary.refetch()} retrying={summary.isFetching}>
        {inventoryListErrorMessage(summary.error, "Não foi possível carregar o resumo. Tente novamente.")}
      </CatalogNotice>
    );
  }

  const data = summary.data;
  const percent = Math.min(100, Math.max(0, data.progress_percent));
  return (
    <section aria-label="Resumo do inventário" className="flex min-w-0 flex-col gap-4" data-testid="inventory-summary">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span id="inv-progresso-rotulo" className="text-eyebrow text-pale-stone">
            Progresso da conferência
          </span>
          <span className="text-body-sm text-bone" data-testid="progress-text">
            {percent}% conferido
          </span>
        </div>
        <div
          role="progressbar"
          aria-labelledby="inv-progresso-rotulo"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% conferido`}
          className="h-2 w-full overflow-hidden rounded-sm bg-carbon-lift"
        >
          <div className="h-full bg-bone" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
        <Metric label="Total de bens" value={data.total_assets} testId="metric-total" />
        <Metric label="Conferidos" value={data.checked} testId="metric-checked" />
        <Metric label="Pendentes" value={data.pending} testId="metric-pending" />
        <Metric label="Encontrados" value={data.found} testId="metric-found" />
        <Metric label="Não encontrados" value={data.not_found} testId="metric-not-found" />
        <Metric label="Divergentes" value={data.divergent} testId="metric-divergent" />
      </dl>
      <p className="text-caption text-warm-granite">
        Números calculados pelo servidor. O total considera os bens ativos da unidade no momento da consulta.
      </p>
    </section>
  );
}
