"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { AssetSort, LocatedStatus } from "@/lib/assets-api";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";
import { GLOBAL_SEARCH_PARAM, normalizeGlobalSearch } from "@/components/layout/header";
import { parsePage, usePagination } from "@/lib/pagination";

// =============================================================================
// Estado de busca/filtros/ordenação/paginação da lista de bens. A busca tem
// debounce (300 ms); qualquer mudança de filtro volta à página 1
// (`pg` = usePagination: page/pageSize 50/100/200). Trocar a
// unidade limpa sala e responsável (pertencem a uma unidade). Tudo é só
// parâmetro de consulta: o backend aplica allowlist, perfil e escopo.
// =============================================================================

export type LocatedFilter = "" | LocatedStatus;

const DEFAULT_SORT: AssetSort = "patrimony_number";

export function useAssetFilters() {
  // Busca global do cabeçalho: `?busca=` (normalizado: trim, espaços colapsados, ≤100).
  // O valor inicial vem da URL (também no SSR, sem divergir da hidratação).
  const searchParams = useSearchParams();
  const urlSearch = normalizeGlobalSearch(searchParams.get(GLOBAL_SEARCH_PARAM) ?? "");
  const [search, setSearch] = useState(urlSearch);
  const [q, setQ] = useState(urlSearch);
  const [unitId, setUnitId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [personId, setPersonId] = useState("");
  const [located, setLocated] = useState<LocatedFilter>("");
  /** "" = todos; `BOND_STATUS_NONE` = sem vínculo; demais = valor vindo do backend. */
  const [bondStatus, setBondStatus] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [sort, setSort] = useState<AssetSort>(DEFAULT_SORT);
  // `?page=` é inválido→1 (parsePage); página além da última é ajustada por useClampPage.
  const pg = usePagination({ initialPage: parsePage(searchParams.get("page")) });
  const { resetPage } = pg;
  // Só volta à página 1 quando o termo (já aparado) realmente muda: digitar um
  // espaço no fim não deve descartar a página em que o usuário está.
  const appliedQ = useRef(urlSearch);
  const lastUrlSearch = useRef(urlSearch);

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

  // Nova busca global com a lista já aberta: sincroniza o campo e aplica na hora.
  useEffect(() => {
    if (urlSearch === lastUrlSearch.current) return;
    lastUrlSearch.current = urlSearch;
    appliedQ.current = urlSearch;
    setSearch(urlSearch);
    setQ(urlSearch);
    resetPage();
  }, [urlSearch, resetPage]);

  function resetOn<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      resetPage();
    };
  }

  function chooseUnit(value: string) {
    setUnitId(value);
    setRoomId("");
    setPersonId("");
    resetPage();
  }

  function clear() {
    setSearch("");
    setQ("");
    appliedQ.current = "";
    setUnitId("");
    setRoomId("");
    setPersonId("");
    setLocated("");
    setBondStatus("");
    setIncludeDeleted(false);
    setSort(DEFAULT_SORT);
    resetPage();
  }

  return {
    search,
    setSearch,
    q,
    unitId,
    roomId,
    personId,
    located,
    bondStatus,
    includeDeleted,
    sort,
    pg,
    chooseUnit,
    chooseRoom: resetOn(setRoomId),
    choosePerson: resetOn(setPersonId),
    chooseLocated: resetOn(setLocated),
    chooseBondStatus: resetOn(setBondStatus),
    chooseIncludeDeleted: resetOn(setIncludeDeleted),
    chooseSort: resetOn(setSort),
    clear,
    /**
     * Qualquer desvio do padrão (busca — inclusive a global `?busca=` —, filtros,
     * "Incluir excluídos" e ordenação) conta: é o que "Limpar filtros" desfaz.
     */
    filtered:
      !!q ||
      !!unitId ||
      !!roomId ||
      !!personId ||
      !!located ||
      !!bondStatus ||
      includeDeleted ||
      sort !== DEFAULT_SORT,
  };
}
