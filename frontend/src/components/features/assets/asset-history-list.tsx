"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { usePagination } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { getAssetHistory } from "@/lib/assets-api";
import { useClampPage } from "./use-clamp-page";
import {
  assetHistoryErrorMessage,
  describeHistory,
  formatDateTime,
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
  // Painel interno: tamanho próprio (50/100/200, padrão 50), sem persistir a preferência da lista.
  const pg = usePagination({ persist: false });
  const { page, pageSize } = pg;
  const history = useQuery({
    queryKey: [...assetHistoryKey(assetId), page, pageSize, includeDeleted],
    queryFn: () => getAssetHistory(assetId, { page, page_size: pageSize, includeDeleted }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  useClampPage(pg, history.data?.total, !history.isPlaceholderData);

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
  if (entries.length === 0 && total === 0) {
    return <EmptyState icon={History} title="Nenhum evento registrado para este bem." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <StaggerContainer
        as="ol"
        key={`${page}|${pageSize}`}
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

      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={pg.setPage}
        onPageSizeChange={pg.setPageSize}
        busy={history.isPlaceholderData}
        noun="evento(s)"
        label="Paginação do histórico"
      />
    </div>
  );
}
