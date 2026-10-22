"use client";

import { useEffect, useRef, useState } from "react";

import { usePagination } from "@/lib/pagination";
import { SEARCH_DEBOUNCE_MS, SEARCH_MAX, type ActiveFilter } from "./catalog-labels";

// =============================================================================
// Estado de busca/filtros/ordenação/paginação das listagens de cadastros.
// - A busca tem debounce (300 ms) e vira `q` = texto sem bordas, espaços
//   internos colapsados e no máximo SEARCH_MAX caracteres (o mesmo tratamento
//   que o backend faz; assim a chave do cache e a URL da API ficam estáveis).
// - A página só volta à 1 quando `q` MUDA de fato (digitar e apagar dentro do
//   debounce não perde a página atual); qualquer filtro/ordenação volta à 1.
// - page/page_size vêm de `usePagination` (backend: 50/100/200).
// Tudo é só parâmetro de consulta: o backend aplica allowlist e escopo.
// =============================================================================

/** Texto de busca pronto para a API (vazio => parâmetro omitido). */
export function normalizeQuery(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
}

export function useCatalogFilters<TSort extends string>(defaultSort: TSort) {
  const pg = usePagination();
  const { resetPage } = pg;
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const appliedQ = useRef("");
  const [unitId, setUnitId] = useState("");
  const [active, setActive] = useState<ActiveFilter>("all");
  const [sort, setSort] = useState<TSort>(defaultSort);

  useEffect(() => {
    const next = normalizeQuery(search);
    if (next === appliedQ.current) return;
    const handle = setTimeout(() => {
      appliedQ.current = next;
      setQ(next);
      resetPage();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, resetPage]);

  function withPageReset<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      resetPage();
    };
  }

  function clear() {
    setSearch("");
    appliedQ.current = "";
    setQ("");
    setUnitId("");
    setActive("all");
    resetPage();
  }

  return {
    search,
    setSearch,
    q,
    unitId,
    active,
    sort,
    pg,
    page: pg.page,
    pageSize: pg.pageSize,
    setPage: pg.setPage,
    setPageSize: pg.setPageSize,
    chooseUnit: withPageReset(setUnitId),
    chooseActive: withPageReset(setActive),
    chooseSort: withPageReset(setSort),
    clear,
    /** Há algo para limpar (inclui texto ainda dentro do debounce). */
    filtered: search !== "" || !!q || !!unitId || active !== "all",
    /** `undefined` quando "todas" (parâmetro omitido na consulta). */
    activeParam: active === "all" ? undefined : active === "true",
  };
}

/**
 * Se a página atual deixou de existir (ex.: inativar o último item da última
 * página), volta para a última página existente.
 */
export function useClampPage(
  pg: { page: number; pageSize: number; setPage: (page: number) => void },
  total: number | undefined,
  settled: boolean,
) {
  useEffect(() => {
    if (total === undefined || !settled) return;
    const last = Math.max(1, Math.ceil(total / pg.pageSize));
    if (pg.page > last) pg.setPage(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só reage a página/total/tamanho
  }, [total, settled, pg.page, pg.pageSize]);
}
