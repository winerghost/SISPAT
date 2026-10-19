"use client";

import { useState } from "react";

import type { MovementListParams, MovementSort } from "@/lib/movements-api";

// =============================================================================
// Estado de filtros/ordenação/paginação da lista de movimentações. Qualquer
// mudança de filtro volta à página 1. Tudo é só parâmetro de consulta: o
// backend aplica allowlist, perfil e escopo (origem OU destino no escopo).
// =============================================================================

export type StatusFilter = "" | NonNullable<MovementListParams["status"]>;

export function useMovementFilters() {
  const [status, setStatus] = useState<StatusFilter>("");
  const [assetId, setAssetId] = useState("");
  const [originUnitId, setOriginUnitId] = useState("");
  const [destinationUnitId, setDestinationUnitId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<MovementSort>("-created_at");
  const [page, setPage] = useState(1);

  function resetPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  function clear() {
    setStatus("");
    setAssetId("");
    setOriginUnitId("");
    setDestinationUnitId("");
    setFrom("");
    setTo("");
    setPage(1);
  }

  return {
    status,
    assetId,
    originUnitId,
    destinationUnitId,
    from,
    to,
    sort,
    page,
    setPage,
    chooseStatus: resetPage(setStatus),
    chooseAsset: resetPage(setAssetId),
    chooseOrigin: resetPage(setOriginUnitId),
    chooseDestination: resetPage(setDestinationUnitId),
    chooseFrom: resetPage(setFrom),
    chooseTo: resetPage(setTo),
    chooseSort: resetPage(setSort),
    clear,
    filtered: !!status || !!assetId || !!originUnitId || !!destinationUnitId || !!from || !!to,
  };
}
