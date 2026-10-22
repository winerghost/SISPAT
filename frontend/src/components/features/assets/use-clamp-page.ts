"use client";

import { useEffect } from "react";

import { totalPagesFor, type PaginationState } from "@/lib/pagination";

/**
 * Se a página pedida ficou além do último (ex.: itens removidos, filtro mudou
 * por outra aba), volta para a última existente. Só age com dados confirmados
 * pelo backend (`total` definido e resposta não é placeholder).
 */
export function useClampPage(pg: PaginationState, total: number | undefined, settled: boolean): void {
  const { page, pageSize, setPage } = pg;
  useEffect(() => {
    if (total === undefined || !settled) return;
    const last = totalPagesFor(total, pageSize);
    if (page > last) setPage(last);
  }, [total, settled, page, pageSize, setPage]);
}
