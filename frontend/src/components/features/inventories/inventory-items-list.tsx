"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { selectControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { listInventoryItems, type InventoryItemResult, type InventoryItemSort } from "@/lib/inventories-api";
import { PatrimonyNumber } from "@/components/features/assets/assets-table";
import { CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { ResultBadge } from "./inventories-table";
import {
  formatDateTime,
  inventoryItemsKey,
  inventoryListErrorMessage,
  ITEMS_PAGE_SIZE,
  RESULT_EXPLANATION,
  RESULT_LABEL,
} from "./inventory-labels";
import { useUnitLocations } from "./use-inventory-data";

// =============================================================================
// Itens conferidos (`GET /inventories/<id>/items`): filtro por resultado,
// ordenação por data (allowlist) e paginação. Resultado, conferidor e data vêm do
// servidor. Observações são TEXTO LIVRE (escapado pelo React; nunca HTML). O
// conferidor aparece só pelo final do identificador. Não há editar nem excluir.
// =============================================================================

const RESULT_FILTERS: readonly InventoryItemResult[] = ["ENCONTRADO", "NAO_ENCONTRADO", "DIVERGENTE"];

function shortId(value: string): string {
  return `…${value.slice(-8)}`;
}

export function InventoryItemsList({ inventoryId, unitId }: { inventoryId: string; unitId: string }) {
  const [result, setResult] = useState<"" | InventoryItemResult>("");
  const [sort, setSort] = useState<InventoryItemSort>("-checked_at");
  const [page, setPage] = useState(1);
  const params = { result: result || undefined, sort, page, page_size: ITEMS_PAGE_SIZE };
  const items = useQuery({
    queryKey: inventoryItemsKey(inventoryId, params),
    queryFn: () => listInventoryItems(inventoryId, params),
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });
  const locations = useUnitLocations(unitId, true);
  const locationName = (id: string | null): string | null => {
    if (!id) return null;
    return locations.data?.locations.find((location) => location.id === id)?.name ?? "local fora da lista";
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="inv-itens-resultado" className="text-eyebrow text-pale-stone">
            Resultado
          </label>
          <select
            id="inv-itens-resultado"
            className={selectControlClassName}
            value={result}
            onChange={(event) => {
              setResult(event.target.value as "" | InventoryItemResult);
              setPage(1);
            }}
          >
            <option value="">Todos os resultados</option>
            {RESULT_FILTERS.map((value) => (
              <option key={value} value={value}>
                {RESULT_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="inv-itens-ordem" className="text-eyebrow text-pale-stone">
            Ordenar por
          </label>
          <select
            id="inv-itens-ordem"
            className={selectControlClassName}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as InventoryItemSort);
              setPage(1);
            }}
          >
            <option value="-checked_at">Conferidos mais recentemente</option>
            <option value="checked_at">Conferidos há mais tempo</option>
          </select>
        </div>
      </div>

      {items.isPending ? <LoadingSkeleton variant="lines" count={3} label="Carregando conferências…" /> : null}

      {items.isError ? (
        <CatalogNotice onRetry={() => items.refetch()} retrying={items.isFetching}>
          {inventoryListErrorMessage(items.error, "Não foi possível carregar as conferências. Tente novamente.")}
        </CatalogNotice>
      ) : null}

      {items.data ? (
        <>
          {items.data.items.length === 0 ? (
            <p className="rounded-cards border border-ash-stroke p-4 text-body-sm text-warm-granite" data-testid="items-empty">
              {result ? "Nenhuma conferência com este resultado." : "Nenhum bem foi conferido neste inventário ainda."}
            </p>
          ) : (
            <ul aria-label="Itens conferidos" className="flex flex-col gap-3">
              {items.data.items.map((item) => {
                const observed = locationName(item.observed_location_id);
                const registered = locationName(item.registered_location_id);
                return (
                  <li key={item.id} className="flex min-w-0 flex-col gap-2 rounded-cards border border-ash-stroke p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <PatrimonyNumber value={item.asset.patrimony_number} />
                      <ResultBadge result={item.result} />
                    </div>
                    <p className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">
                      {item.asset.description ?? "—"}
                    </p>
                    <p className="text-caption text-warm-granite">{RESULT_EXPLANATION[item.result]}</p>
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-caption text-warm-granite sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="inline">Conferido em: </dt>
                        <dd className="inline text-pale-stone">{formatDateTime(item.checked_at) ?? "—"}</dd>
                      </div>
                      {item.checked_by ? (
                        <div className="min-w-0">
                          <dt className="inline">Conferidor (identificador): </dt>
                          <dd className="inline text-pale-stone">
                            <span translate="no" className="font-mono">
                              {shortId(item.checked_by)}
                            </span>
                          </dd>
                        </div>
                      ) : null}
                      <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                        <dt className="inline">Local cadastrado: </dt>
                        <dd className="inline text-pale-stone">{registered ?? "sem local"}</dd>
                      </div>
                      <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                        <dt className="inline">Local observado: </dt>
                        <dd className="inline text-pale-stone">{observed ?? "não informado"}</dd>
                      </div>
                    </dl>
                    {item.notes ? (
                      <p className="whitespace-pre-wrap break-words text-body-sm text-bone [overflow-wrap:anywhere]">
                        <span className="text-eyebrow text-pale-stone">Observações: </span>
                        {item.notes}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <CatalogPagination
            page={items.data.page}
            total={items.data.total}
            pageSize={ITEMS_PAGE_SIZE}
            noun="conferência(s)"
            loading={items.isPlaceholderData}
            onPage={setPage}
          />
        </>
      ) : null}
    </div>
  );
}
