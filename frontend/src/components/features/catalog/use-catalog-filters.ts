"use client";

import { useEffect, useState } from "react";

import { SEARCH_DEBOUNCE_MS, type ActiveFilter } from "./catalog-labels";

// =============================================================================
// Estado de busca/filtros/ordenação/paginação das listagens de cadastros.
// A busca tem debounce (300 ms); qualquer mudança de filtro volta à página 1.
// Tudo é só parâmetro de consulta: o backend aplica allowlist e escopo.
// =============================================================================

export function useCatalogFilters<TSort extends string>(defaultSort: TSort) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [unitId, setUnitId] = useState("");
  const [active, setActive] = useState<ActiveFilter>("all");
  const [sort, setSort] = useState<TSort>(defaultSort);
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
    setUnitId("");
    setActive("all");
    setPage(1);
  }

  return {
    search,
    setSearch,
    q,
    unitId,
    active,
    sort,
    page,
    setPage,
    chooseUnit: resetPage(setUnitId),
    chooseActive: resetPage(setActive),
    chooseSort: resetPage(setSort),
    clear,
    filtered: !!q || !!unitId || active !== "all",
    /** `undefined` quando "todas" (parâmetro omitido na consulta). */
    activeParam: active === "all" ? undefined : active === "true",
  };
}
