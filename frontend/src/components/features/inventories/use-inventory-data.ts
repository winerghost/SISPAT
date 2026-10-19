"use client";

import { useQuery } from "@tanstack/react-query";

import {
  listInventoryItems,
  listLocations,
  type InventoryItemResult,
} from "@/lib/inventories-api";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { inventoriesQueryKey } from "./inventory-labels";

// =============================================================================
// Dados de apoio do detalhe de inventário.
// - Locais da unidade (`GET /locations?unit_id=`): máx. 100 itens (limite do
//   backend); o escopo é aplicado pelo servidor.
// - Mapa "bem → resultado" das conferências já feitas: lê as páginas de
//   `/items` (100 por página, até MAX_PAGES). Serve só para marcar a lista de bens
//   da unidade; a AUTORIDADE continua sendo o servidor (409 `already_checked`).
// =============================================================================

const LOCATION_PAGE_SIZE = 100;
const CHECKED_PAGE_SIZE = 100;
/** Teto de páginas lidas (1000 conferências). Acima disso o mapa é parcial. */
export const CHECKED_MAX_PAGES = 10;

export function useUnitLocations(unitId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...inventoriesQueryKey, "locations", unitId],
    queryFn: () => listLocations({ unit_id: unitId, page_size: LOCATION_PAGE_SIZE, sort: "name" }),
    enabled: enabled && !!unitId,
    staleTime: 30_000,
    retry: noClientRetry,
  });
}

export interface CheckedMap {
  results: Map<string, InventoryItemResult>;
  /** `false` quando há mais conferências do que o teto lido (mapa parcial). */
  complete: boolean;
}

export function useCheckedMap(inventoryId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...inventoriesQueryKey, "checked-map", inventoryId],
    queryFn: async (): Promise<CheckedMap> => {
      const results = new Map<string, InventoryItemResult>();
      let page = 1;
      for (;;) {
        const response = await listInventoryItems(inventoryId, {
          page,
          page_size: CHECKED_PAGE_SIZE,
          sort: "checked_at",
        });
        for (const item of response.items) results.set(item.asset.id, item.result);
        if (page * CHECKED_PAGE_SIZE >= response.total) return { results, complete: true };
        if (page >= CHECKED_MAX_PAGES) return { results, complete: false };
        page += 1;
      }
    },
    enabled: enabled && !!inventoryId,
    retry: noClientRetry,
  });
}
