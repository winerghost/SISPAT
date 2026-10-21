"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  dashboardFiltersQueryString,
  parseDashboardFilters,
  type DashboardFilterKey,
  type DashboardFilters,
} from "@/lib/dashboard-api";

import { togglePatch, type FilterPatch } from "./dashboard-chart-filters";

// =============================================================================
// Filtros do dashboard NA URL (link compartilhável; nada é salvo por usuário).
// =============================================================================
// - `applied`: filtros lidos da URL com parse defensivo (chave desconhecida,
//   repetida ou valor inválido é DESCARTADO — a tela nunca quebra). São estes
//   que vão para as consultas (queryKeys) e para o resumo "filtros ativos".
// - `draft`: o que os controles mostram. Cada mudança é gravada na URL com
//   `router.replace` (sem recarregar, sem nova entrada no histórico) depois de
//   um debounce curto — várias trocas seguidas viram UMA rodada de consultas
//   (cerca de 10 endpoints por rodada; o backend limita por usuário/rota).
// - URL com lixo é normalizada (substituída pela versão limpa) para que o link
//   copiado nunca carregue valor que o backend recusaria.
// - Voltar/avançar do navegador: a URL nova vira o rascunho.
// A validação real é do backend (400); isto só evita enviar lixo.
// =============================================================================

export const FILTER_DEBOUNCE_MS = 400;

/** Trocar a unidade de uso limpa sala e pessoa (pertencem a uma unidade). */
const DEPENDS_ON_UNIT: readonly DashboardFilterKey[] = ["room_id", "responsible_person_id"];

export function hrefWithFilters(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}

/** Só leitura (relatório e link "Imprimir relatório"). */
export function useAppliedDashboardFilters(): { filters: DashboardFilters; query: string } {
  const searchParams = useSearchParams();
  const raw = searchParams.toString();
  return useMemo(() => {
    const filters = parseDashboardFilters(new URLSearchParams(raw));
    return { filters, query: dashboardFiltersQueryString(filters) };
  }, [raw]);
}

export function useDashboardUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.toString();
  const { filters: applied, query: appliedQuery } = useAppliedDashboardFilters();

  const [draft, setDraft] = useState<DashboardFilters>(applied);
  /** Última query que ESTA tela gravou (distingue mudança própria de externa). */
  const written = useRef(appliedQuery);

  const write = useCallback(
    (query: string) => {
      written.current = query;
      router.replace(hrefWithFilters(pathname, query), { scroll: false });
    },
    [router, pathname],
  );

  // URL mudou por fora (voltar/avançar, link): ela vira o rascunho.
  useEffect(() => {
    if (appliedQuery !== written.current) {
      written.current = appliedQuery;
      setDraft(applied);
    }
  }, [appliedQuery, applied]);

  // URL com chave/valor inválido, repetido ou fora de ordem: normaliza.
  useEffect(() => {
    if (raw !== appliedQuery) write(appliedQuery);
  }, [raw, appliedQuery, write]);

  // Rascunho → URL com debounce.
  const draftQuery = dashboardFiltersQueryString(draft);
  useEffect(() => {
    if (draftQuery === written.current) return;
    const handle = setTimeout(() => write(draftQuery), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draftQuery, write]);

  const set = useCallback((key: DashboardFilterKey, value: string) => {
    setDraft((current) => {
      const next: Record<string, string | undefined> = { ...current };
      if (value === "") delete next[key];
      else next[key] = value;
      if (key === "unit_id" && current.unit_id !== (value || undefined)) {
        for (const dependent of DEPENDS_ON_UNIT) delete next[dependent];
      }
      return next as DashboardFilters;
    });
  }, []);

  /**
   * Clique num gráfico: aplica o patch (ou o remove, se já aplicado). Mesmo
   * caminho dos seletores (rascunho → URL com debounce); trocar a unidade
   * limpa sala/pessoa, como no seletor.
   */
  const toggle = useCallback((patch: FilterPatch) => {
    setDraft((current) => {
      const next = togglePatch(current, patch) as Record<string, string | undefined>;
      if ("unit_id" in patch && current.unit_id !== next.unit_id) {
        for (const dependent of DEPENDS_ON_UNIT) if (!(dependent in patch)) delete next[dependent];
      }
      return next as DashboardFilters;
    });
  }, []);

  /** "Limpar filtros": imediato (sem debounce). */
  const clear = useCallback(() => {
    setDraft({});
    write("");
  }, [write]);

  return {
    /** Filtros válidos da URL (usados nas consultas e no resumo). */
    applied,
    appliedQuery,
    /** Valores exibidos nos controles (podem conter período ainda inválido). */
    draft,
    set,
    toggle,
    clear,
    /** Há filtro na URL ou no rascunho (habilita "Limpar filtros"). */
    hasAny: appliedQuery !== "" || Object.keys(draft).length > 0,
  };
}

export type DashboardUrlFilters = ReturnType<typeof useDashboardUrlFilters>;
