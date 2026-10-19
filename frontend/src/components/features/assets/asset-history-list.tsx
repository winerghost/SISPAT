"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { cn } from "@/lib/utils";
import { getAssetHistory } from "@/lib/assets-api";
import {
  assetHistoryErrorMessage,
  describeHistory,
  formatDateTime,
  HISTORY_PAGE_SIZE,
  OPERATION_LABEL,
} from "./asset-labels";

// =============================================================================
// Histórico — `GET /api/v1/assets/<id>/history` (paginado, mais recentes
// primeiro). Quem pode ler o bem pode ler o histórico; a decisão é do backend
// (erro 403/404 vira mensagem fixa). Valores anteriores/novos são exibidos
// SEMPRE como texto escapado pelo React (nunca HTML); `notes` nunca mostra
// conteúdo. `actor_user_id` é só um identificador (mostramos o final). Datas em
// America/Araguaina.
// =============================================================================

export const assetHistoryKey = (assetId: string) => ["assets", "history", assetId] as const;

export function AssetHistoryList({ assetId, includeDeleted }: { assetId: string; includeDeleted: boolean }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: [...assetHistoryKey(assetId), page, includeDeleted],
    queryFn: () => getAssetHistory(assetId, { page, page_size: HISTORY_PAGE_SIZE, includeDeleted }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  if (history.isPending) return <LoadingSkeleton variant="lines" count={4} label="Carregando histórico…" />;

  if (history.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormMessage>{assetHistoryErrorMessage(history.error)}</FormMessage>
        <Button variant="outline" size="sm" loading={history.isFetching} onClick={() => history.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const { entries, total } = history.data;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));

  if (entries.length === 0) {
    return <EmptyState icon={History} title="Nenhum evento registrado para este bem." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <StaggerContainer
        as="ol"
        key={page}
        aria-label="Histórico do bem"
        aria-busy={history.isPlaceholderData || undefined}
        className={cn("flex flex-col gap-3 transition-opacity duration-base ease-factory", history.isPlaceholderData && "opacity-60")}
      >
        {entries.map((entry, index) => {
          const lines = describeHistory(entry.previous_values, entry.new_values);
          const success = /^(sucesso|success)$/i.test(entry.result);
          return (
            <StaggerItem as="li" key={entry.id} index={index} className="flex flex-col gap-1.5 rounded-cards border border-ash-stroke p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-bone">{OPERATION_LABEL[entry.operation] ?? entry.operation}</span>
                <Badge variant={success ? "success" : "warning"}>{entry.result}</Badge>
              </div>
              <p className="text-caption leading-[1.4] text-warm-granite">
                <time dateTime={entry.occurred_at}>{formatDateTime(entry.occurred_at) ?? entry.occurred_at}</time>
                {" · "}
                {entry.actor_user_id ? (
                  <>
                    usuário <span translate="no">…{entry.actor_user_id.slice(-8)}</span>
                  </>
                ) : (
                  "pelo sistema"
                )}
              </p>
              {lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-body-sm text-pale-stone">
                  {lines.map((line, i) => (
                    <li key={i} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </StaggerItem>
          );
        })}
      </StaggerContainer>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body-sm text-warm-granite" aria-live="polite">
          Página {history.data.page} de {totalPages} · {total} evento(s)
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || history.isPlaceholderData} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || history.isPlaceholderData}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      </div>
    </div>
  );
}
