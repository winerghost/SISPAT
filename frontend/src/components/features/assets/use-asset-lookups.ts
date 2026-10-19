"use client";

import { useQuery } from "@tanstack/react-query";

import { listPeople, listRooms } from "@/lib/catalog-api";
import { noClientRetry } from "@/components/features/lookup/use-lookup";

// =============================================================================
// Seletores de apoio: salas (`GET /rooms`) e pessoas responsáveis
// (`GET /responsible-people`) de UMA unidade. O backend aplica escopo e campos
// por perfil (USER recebe pessoas só com id/name/unit_id/active). Só consulta
// quando há unidade; no máximo 100 itens (limite do backend).
// =============================================================================

const LOOKUP_PAGE_SIZE = 100;

/** `activeOnly`: formulário (só ativos); filtro: inclui inativos (bens podem estar vinculados a eles). */
export function useUnitRooms(unitId: string, enabled: boolean, activeOnly: boolean) {
  return useQuery({
    queryKey: ["assets", "lookup", "rooms", unitId, activeOnly],
    queryFn: () =>
      listRooms({ unit_id: unitId, active: activeOnly ? true : undefined, page_size: LOOKUP_PAGE_SIZE, sort: "name" }),
    enabled: enabled && !!unitId,
    staleTime: 30_000,
    retry: noClientRetry,
  });
}

export function useUnitPeople(unitId: string, enabled: boolean, activeOnly: boolean) {
  return useQuery({
    queryKey: ["assets", "lookup", "people", unitId, activeOnly],
    queryFn: () =>
      listPeople({ unit_id: unitId, active: activeOnly ? true : undefined, page_size: LOOKUP_PAGE_SIZE, sort: "name" }),
    enabled: enabled && !!unitId,
    staleTime: 30_000,
    retry: noClientRetry,
  });
}
