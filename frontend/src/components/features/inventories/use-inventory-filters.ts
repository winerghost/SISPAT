"use client";

import { useEffect, useState } from "react";

import type { InventorySort, InventoryStatus } from "@/lib/inventories-api";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";

// =============================================================================
// Estado de busca/filtros/ordenação/paginação da lista de inventários. A busca
// por nome tem debounce (300 ms); qualquer mudança de filtro volta à página 1.
// Tudo é só parâmetro de consulta: o backend aplica allowlist, perfil e escopo.
// =============================================================================

export type StatusFilter = "" | InventoryStatus;

export function useInventoryFilters() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [unitId, setUnitId] = useState("");
  const [sort, setSort] = useState<InventorySort>("-created_at");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  function resetPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  function clear() {
    setSearch("");
    setQ("");
    setStatus("");
    setUnitId("");
    setPage(1);
  }

  return {
    search,
    setSearch,
    q,
    status,
    unitId,
    sort,
    page,
    setPage,
    chooseStatus: resetPage(setStatus),
    chooseUnit: resetPage(setUnitId),
    chooseSort: resetPage(setSort),
    clear,
    filtered: !!q || !!status || !!unitId,
  };
}
