"use client";

import { useEffect, useState } from "react";

import type { AssetSort, LocatedStatus } from "@/lib/assets-api";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";

// =============================================================================
// Estado de busca/filtros/ordenação/paginação da lista de bens. A busca tem
// debounce (300 ms); qualquer mudança de filtro volta à página 1. Trocar a
// unidade limpa sala e responsável (pertencem a uma unidade). Tudo é só
// parâmetro de consulta: o backend aplica allowlist, perfil e escopo.
// =============================================================================

export type LocatedFilter = "" | LocatedStatus;

export function useAssetFilters() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [unitId, setUnitId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [personId, setPersonId] = useState("");
  const [located, setLocated] = useState<LocatedFilter>("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [sort, setSort] = useState<AssetSort>("patrimony_number");
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

  function chooseUnit(value: string) {
    setUnitId(value);
    setRoomId("");
    setPersonId("");
    setPage(1);
  }

  function clear() {
    setSearch("");
    setQ("");
    setUnitId("");
    setRoomId("");
    setPersonId("");
    setLocated("");
    setPage(1);
  }

  return {
    search,
    setSearch,
    q,
    unitId,
    roomId,
    personId,
    located,
    includeDeleted,
    sort,
    page,
    setPage,
    chooseUnit,
    chooseRoom: resetPage(setRoomId),
    choosePerson: resetPage(setPersonId),
    chooseLocated: resetPage(setLocated),
    chooseIncludeDeleted: resetPage(setIncludeDeleted),
    chooseSort: resetPage(setSort),
    clear,
    /** "Incluir excluídos" é uma visão, não um filtro de refino: fica fora de `filtered`. */
    filtered: !!q || !!unitId || !!roomId || !!personId || !!located,
  };
}
