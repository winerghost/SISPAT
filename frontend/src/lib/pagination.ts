"use client";

import { useCallback, useEffect, useState } from "react";

// =============================================================================
// Paginação compartilhada. O backend só aceita page_size ∈ {50, 100, 200}
// (padrão 50; qualquer outro valor é rejeitado), então TODO valor lido de URL,
// storage ou estado passa por `parsePageSize` antes de ir para a API.
// A preferência de tamanho fica em sessionStorage (dado não sensível; nunca
// tokens) com try/catch — storage bloqueado apenas desliga a persistência.
// =============================================================================

export const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;
export const PAGE_SIZE_STORAGE_KEY = "sispat-page-size";

/** Valor inválido/ausente → 50. */
export function parsePageSize(value: unknown): PageSize {
  const n = typeof value === "string" ? (/^\d{1,4}$/.test(value) ? Number(value) : NaN) : value;
  return PAGE_SIZE_OPTIONS.find((option) => option === n) ?? DEFAULT_PAGE_SIZE;
}

/** Inteiro >= 1; inválido/ausente → 1. */
export function parsePage(value: unknown): number {
  const n = typeof value === "string" ? (/^\d{1,7}$/.test(value) ? Number(value) : NaN) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
}

export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** Intervalo exibido (1-based, inclusivo); página fora do total é limitada. total=0 → 0–0. */
export function pageRange(page: number, pageSize: number, total: number) {
  if (total <= 0) return { from: 0, to: 0 };
  const safePage = Math.min(parsePage(page), totalPagesFor(total, pageSize));
  return { from: (safePage - 1) * pageSize + 1, to: Math.min(total, safePage * pageSize) };
}

type SearchLike = { get(name: string): string | null };

/** Lê page/page_size de URLSearchParams (valores inválidos viram padrão). */
export function readPaginationFromSearch(search: SearchLike): { page: number; pageSize: PageSize } {
  return { page: parsePage(search.get("page")), pageSize: parsePageSize(search.get("page_size")) };
}

/** Grava page/page_size em uma cópia de URLSearchParams (omite os padrões). */
export function writePaginationToSearch(
  search: URLSearchParams,
  state: { page: number; pageSize: number },
): URLSearchParams {
  const next = new URLSearchParams(search);
  if (state.page > 1) next.set("page", String(state.page));
  else next.delete("page");
  if (state.pageSize !== DEFAULT_PAGE_SIZE) next.set("page_size", String(parsePageSize(state.pageSize)));
  else next.delete("page_size");
  return next;
}

function readStoredPageSize(key: string): PageSize | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : parsePageSize(raw);
  } catch {
    return null;
  }
}

function storePageSize(key: string, size: PageSize): void {
  try {
    window.sessionStorage.setItem(key, String(size));
  } catch {
    /* storage indisponível: sem persistência */
  }
}

export interface UsePaginationOptions {
  initialPage?: number;
  initialPageSize?: number;
  /** Persistir page_size em sessionStorage (padrão: true). */
  persist?: boolean;
  storageKey?: string;
}

export interface PaginationState {
  page: number;
  pageSize: PageSize;
  setPage: (page: number) => void;
  /** Troca o tamanho e volta para a página 1. */
  setPageSize: (size: number) => void;
  /** Volte para a página 1 — chame ao alterar busca/filtros/ordenação. */
  resetPage: () => void;
}

/**
 * Estado de paginação. O tamanho salvo é aplicado após a montagem (evita
 * divergência de hidratação). Use `pageSize`/`page` direto nos params da API.
 */
export function usePagination(options: UsePaginationOptions = {}): PaginationState {
  const { initialPage, initialPageSize, persist = true, storageKey = PAGE_SIZE_STORAGE_KEY } = options;
  const [page, setPageState] = useState(() => parsePage(initialPage));
  const [pageSize, setPageSizeState] = useState<PageSize>(() => parsePageSize(initialPageSize));

  useEffect(() => {
    if (!persist || initialPageSize !== undefined) return;
    const stored = readStoredPageSize(storageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na montagem
    if (stored !== null && stored !== DEFAULT_PAGE_SIZE) setPageSizeState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPage = useCallback((next: number) => setPageState(parsePage(next)), []);
  const resetPage = useCallback(() => setPageState(1), []);
  const setPageSize = useCallback(
    (size: number) => {
      const parsed = parsePageSize(size);
      setPageSizeState(parsed);
      setPageState(1);
      if (persist) storePageSize(storageKey, parsed);
    },
    [persist, storageKey],
  );

  return { page, pageSize, setPage, setPageSize, resetPage };
}
