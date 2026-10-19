"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, TriangleAlert } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { getGoogleSheetsPendingReport } from "@/lib/imports-api";

import { catalogImportErrorMessage, pendingLabel } from "./catalog-import-labels";

// =============================================================================
// PendingCountsPanel — pendências de VÍNCULO da prévia de bens (unidade sem
// alias, sala/pessoa não encontrada ou ambígua...). Mostra `pending_counts` da
// prévia e permite carregar o relatório do servidor
// (`GET /imports/google-sheets/<id>/pending`). São só contadores: NÃO bloqueiam
// a confirmação (o bem é importado sem o vínculo ausente). Os números vêm do
// backend e não são animados. Lista semântica (não tabela) e ícone + texto.
// =============================================================================

interface Props {
  previewId: string;
  counts: Record<string, number>;
}

export function PendingCountsPanel({ previewId, counts }: Props) {
  const [requested, setRequested] = useState(false);
  const report = useQuery({
    queryKey: ["import-pending-report", previewId],
    queryFn: () => getGoogleSheetsPendingReport(previewId),
    enabled: requested,
    staleTime: 0,
    retry: false,
  });

  const shown = report.data?.pending_counts ?? counts;
  const entries = Object.entries(shown);
  const withPending = entries.filter(([, count]) => count > 0);
  const total = withPending.reduce((sum, [, count]) => sum + count, 0);
  // Relatório carregado lista todos os códigos (inclusive zerados); antes disso só os com pendência.
  const listed = report.data ? entries : withPending;

  return (
    <SlideIn distance="sm">
      <section
        aria-labelledby="pending-title"
        data-testid="pending-panel"
        className="flex flex-col gap-4 rounded-cards border border-carbon-lift p-card-padding"
      >
        <div className="flex flex-col gap-1">
          <h2 id="pending-title" className="text-eyebrow text-pale-stone">
            Pendências de vínculo {total > 0 ? <span className="text-bone">({total})</span> : null}
          </h2>
          <p className="text-body-sm text-warm-granite">
            Linhas cuja unidade, sala ou pessoa não foi encontrada nos cadastros. Não bloqueiam a confirmação: o
            bem é importado sem o vínculo ausente.
          </p>
        </div>

        {withPending.length === 0 ? (
          <p role="status" className="inline-flex items-center gap-2 text-body-sm text-metric-green">
            <CircleCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            Nenhuma pendência de vínculo nesta prévia.
          </p>
        ) : null}

        {listed.length > 0 ? (
          <ul className="grid gap-1.5 text-body-sm sm:grid-cols-2">
            {listed.map(([code, count]) => (
              <li key={code} className="flex items-start gap-2" data-pending-code={code}>
                <TriangleAlert
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${count > 0 ? "text-signal-orange" : "text-warm-granite"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {pendingLabel(code)}: <span className="text-bone">{count}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {report.isError ? <FormMessage>{catalogImportErrorMessage(report.error, "pending")}</FormMessage> : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            loading={report.isFetching}
            onClick={() => (requested ? void report.refetch() : setRequested(true))}
          >
            {report.data ? "Atualizar relatório de pendências" : "Carregar relatório de pendências"}
          </Button>
          {report.data ? (
            <span role="status" className="text-caption text-pale-stone">
              Relatório carregado do servidor.
            </span>
          ) : null}
          {withPending.length > 0 ? (
            <Link
              href="/administracao/importacao/cadastros"
              className="inline-flex min-h-8 items-center text-body-sm text-bone underline underline-offset-4 transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
            >
              Importar cadastros de apoio (unidades, salas, pessoas)
            </Link>
          ) : null}
        </div>
      </section>
    </SlideIn>
  );
}
