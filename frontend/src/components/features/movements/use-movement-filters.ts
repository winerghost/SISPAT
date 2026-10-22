"use client";

import { useState } from "react";

import { usePagination } from "@/lib/pagination";
import type { MovementListParams, MovementSort } from "@/lib/movements-api";

// =============================================================================
// Estado de filtros/ordenação/paginação da lista de movimentações. Qualquer
// mudança de filtro volta à página 1. Tudo é só parâmetro de consulta: o
// backend aplica allowlist, perfil e escopo (origem OU destino no escopo).
// =============================================================================

export type StatusFilter = "" | NonNullable<MovementListParams["status"]>;

export type TypeFilter = "" | NonNullable<MovementListParams["movement_type"]>;

export function useMovementFilters() {
  const [status, setStatus] = useState<StatusFilter>("");
  const [movementType, setMovementType] = useState<TypeFilter>("");
  const [assetId, setAssetId] = useState("");
  const [originUnitId, setOriginUnitId] = useState("");
  const [destinationUnitId, setDestinationUnitId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<MovementSort>("-created_at");
  const pg = usePagination();

  function resetPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      pg.resetPage();
    };
  }

  function clear() {
    setStatus("");
    setMovementType("");
    setAssetId("");
    setOriginUnitId("");
    setDestinationUnitId("");
    setFrom("");
    setTo("");
    pg.resetPage();
  }

  return {
    status,
    movementType,
    assetId,
    originUnitId,
    destinationUnitId,
    from,
    to,
    sort,
    page: pg.page,
    pageSize: pg.pageSize,
    setPage: pg.setPage,
    setPageSize: pg.setPageSize,
    chooseStatus: resetPage(setStatus),
    chooseType: resetPage(setMovementType),
    chooseAsset: resetPage(setAssetId),
    chooseOrigin: resetPage(setOriginUnitId),
    chooseDestination: resetPage(setDestinationUnitId),
    chooseFrom: resetPage(setFrom),
    chooseTo: resetPage(setTo),
    chooseSort: resetPage(setSort),
    clear,
    filtered: !!status || !!movementType || !!assetId || !!originUnitId || !!destinationUnitId || !!from || !!to,
  };
}
