"use client";

import { useEffect, useRef, useState } from "react";

import type { InventorySort, InventoryStatus } from "@/lib/inventories-api";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";
import { usePagination } from "@/lib/pagination";

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
  const pg = usePagination();
  const { resetPage } = pg;
  // Só reseta a página quando o termo aparado muda de fato.
  const appliedQ = useRef("");

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = search.trim();
      if (next === appliedQ.current) return;
      appliedQ.current = next;
      setQ(next);
      resetPage();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, resetPage]);

  function resetOn<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      resetPage();
    };
  }

  function clear() {
    setSearch("");
    setQ("");
    appliedQ.current = "";
    setStatus("");
    setUnitId("");
    resetPage();
  }

  return {
    search,
    setSearch,
    q,
    status,
    unitId,
    sort,
    pg,
    chooseStatus: resetOn(setStatus),
    chooseUnit: resetOn(setUnitId),
    chooseSort: resetOn(setSort),
    clear,
    filtered: !!q || !!status || !!unitId,
  };
}
