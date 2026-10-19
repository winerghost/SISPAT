"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Switch } from "@/components/ui/switch";
import { listAssets, type AssetRecord } from "@/lib/assets-api";
import { PatrimonyNumber } from "@/components/features/assets/assets-table";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";
import { CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { ResultBadge } from "./inventories-table";
import { inventoriesQueryKey, inventoryListErrorMessage, ITEMS_PAGE_SIZE, SEARCH_MAX } from "./inventory-labels";
import { useCheckedMap } from "./use-inventory-data";

// =============================================================================
// Bens da unidade do inventário (`GET /assets?unit_id=`), com a situação de cada
// um nesta campanha: Pendente ou o resultado da conferência (mapa lido de
// `/items`). "Conferir" só aparece para bens PENDENTES, com o inventário EM
// ANDAMENTO e perfil que pode conferir (UX; o backend decide e responde 409
// `already_checked` em corrida). Busca com debounce. "Ocultar já conferidos" age só
// sobre a página carregada (o servidor não filtra pendentes). Não há reconferência.
// =============================================================================

export function InventoryAssetsPanel({
  inventoryId,
  unitId,
  canCheck,
  onCheck,
}: {
  inventoryId: string;
  unitId: string;
  /** Inventário EM ANDAMENTO e perfil ADM/USER. */
  canCheck: boolean;
  onCheck: (asset: AssetRecord) => void;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [hideChecked, setHideChecked] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const params = { unit_id: unitId, q: q || undefined, sort: "patrimony_number" as const, page, page_size: ITEMS_PAGE_SIZE };
  const assets = useQuery({
    queryKey: [...inventoriesQueryKey, "unit-assets", inventoryId, params],
    queryFn: () => listAssets(params),
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });
  const checked = useCheckedMap(inventoryId, true);

  const rows = (assets.data?.assets ?? []).filter((asset) => !(hideChecked && checked.data?.results.has(asset.id)));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-body-sm text-warm-granite">
        Bens ativos da unidade do inventário. “Pendente” = ainda não conferido nesta campanha.
      </p>
      <div className="flex flex-col gap-3">
        <Input
          type="search"
          aria-label="Buscar bem da unidade por número patrimonial ou descrição"
          placeholder="Buscar por patrimônio ou descrição…"
          maxLength={SEARCH_MAX}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Switch
          label="Ocultar bens já conferidos"
          description="Vale só para a página exibida."
          checked={hideChecked}
          onCheckedChange={setHideChecked}
        />
      </div>

      {checked.isError ? (
        <p className="text-caption text-warm-granite" role="status">
          Não foi possível ler as conferências já feitas. A situação dos bens pode estar incompleta; o servidor continua
          impedindo conferências repetidas.
        </p>
      ) : null}
      {checked.data && !checked.data.complete ? (
        <p className="text-caption text-warm-granite" role="status">
          Há muitas conferências: a situação mostrada pode estar incompleta. O servidor continua impedindo repetições.
        </p>
      ) : null}

      {assets.isPending ? <LoadingSkeleton variant="lines" count={3} label="Carregando bens da unidade…" /> : null}

      {assets.isError ? (
        <CatalogNotice onRetry={() => assets.refetch()} retrying={assets.isFetching}>
          {inventoryListErrorMessage(assets.error, "Não foi possível carregar os bens da unidade. Tente novamente.")}
        </CatalogNotice>
      ) : null}

      {assets.data ? (
        <>
          {rows.length === 0 ? (
            <p className="rounded-cards border border-ash-stroke p-4 text-body-sm text-warm-granite" data-testid="assets-empty">
              {q ? "Nenhum bem encontrado para esta busca." : hideChecked && assets.data.assets.length > 0 ? "Todos os bens desta página já foram conferidos." : "Nenhum bem ativo nesta unidade."}
            </p>
          ) : (
            <ul aria-label="Bens da unidade" className="flex flex-col gap-3">
              {rows.map((asset) => {
                const result = checked.data?.results.get(asset.id);
                return (
                  <li
                    key={asset.id}
                    className="flex min-w-0 flex-col gap-2 rounded-cards border border-ash-stroke p-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <PatrimonyNumber value={asset.patrimony_number} />
                      <span className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">
                        {asset.description ?? "—"}
                      </span>
                      <span className="break-words text-caption text-warm-granite [overflow-wrap:anywhere]">
                        Local cadastrado: {asset.location?.name ?? "sem local"}
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {result ? (
                        <ResultBadge result={result} />
                      ) : (
                        <>
                          <Badge variant="default">
                            <Clock aria-hidden="true" />
                            Pendente
                          </Badge>
                          {canCheck ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onCheck(asset)}
                              aria-label={`Conferir o patrimônio ${asset.patrimony_number}`}
                            >
                              Conferir
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <CatalogPagination
            page={assets.data.page}
            total={assets.data.total}
            pageSize={ITEMS_PAGE_SIZE}
            noun="bem(ns)"
            loading={assets.isPlaceholderData}
            onPage={setPage}
          />
        </>
      ) : null}
    </div>
  );
}
