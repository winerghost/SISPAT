"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import type { AssetRecord } from "@/lib/assets-api";
import { listMovements, type MovementRecord } from "@/lib/movements-api";
import { CatalogHeader, CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { SESSION_ERROR_MESSAGE } from "@/components/features/lookup/lookup-labels";
import { noClientRetry, useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { MovementDetailSheet } from "./movement-detail-sheet";
import {
  MOVEMENT_LOOKUPS_ERROR_MESSAGE,
  MOVEMENT_PAGE_SIZE,
  movementListErrorMessage,
  movementListKey,
} from "./movement-labels";
import { MovementRequestDialog } from "./movement-request-dialog";
import { MovementsTable } from "./movements-table";
import { MovementsToolbar } from "./movements-toolbar";
import { useMovementFilters } from "./use-movement-filters";

// =============================================================================
// /movimentacoes — lista real (`GET /api/v1/movements`). Filtros de estado, bem,
// unidade de origem/destino e período, ordenação (allowlist) e paginação vão como
// parâmetros; o BACKEND aplica perfil, escopo (origem OU destino) e campos por
// perfil. Esta tela é só apresentação: esconder botões por perfil é UX, nunca
// segurança. Detalhe/aprovar/rejeitar/cancelar ficam no painel lateral; solicitar
// é um diálogo. Não há editar/excluir: o histórico é imutável. Nenhum número é
// animado; o total vem do backend.
// =============================================================================

export function MovimentacoesPage() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const filters = useMovementFilters();
  const roles = access.me.data?.roles ?? [];
  const canWrite = roles.includes("ADM") || roles.includes("USER");

  const [pickedAsset, setPickedAsset] = useState<AssetRecord | null>(null);
  const [selected, setSelected] = useState<MovementRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestSession, setRequestSession] = useState(0);

  const params = {
    status: filters.status || undefined,
    asset_id: filters.assetId || undefined,
    origin_unit_id: filters.originUnitId || undefined,
    destination_unit_id: filters.destinationUnitId || undefined,
    created_from: filters.from || undefined,
    created_to: filters.to || undefined,
    sort: filters.sort,
    page: filters.page,
    page_size: MOVEMENT_PAGE_SIZE,
  };
  const movements = useQuery({
    queryKey: movementListKey(params),
    queryFn: () => listMovements(params),
    enabled: access.ready,
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Patrimônio"
        title="Movimentações"
        description={
          canWrite || !access.ready
            ? "Transferências de bens entre unidades, salas e responsáveis. Uma solicitação só altera o bem quando um administrador a aprova; o histórico é imutável."
            : "Transferências de bens entre unidades, salas e responsáveis. Seu perfil é somente de consulta."
        }
        action={
          canWrite ? (
            <Button
              onClick={() => {
                setRequestSession((n) => n + 1);
                setRequestOpen(true);
              }}
            >
              Solicitar movimentação
            </Button>
          ) : null
        }
      />

      <MovementsToolbar filters={filters} units={units.data?.units} pickedAsset={pickedAsset} onPickAsset={setPickedAsset} />

      {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}
      {units.isError && !movements.isError ? <CatalogNotice>{MOVEMENT_LOOKUPS_ERROR_MESSAGE}</CatalogNotice> : null}

      {!access.sessionError && (access.me.isPending || movements.isPending) && (
        <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando movimentações…" />
      )}

      {movements.isError && (
        <CatalogNotice onRetry={() => movements.refetch()} retrying={movements.isFetching}>
          {movementListErrorMessage(movements.error)}
        </CatalogNotice>
      )}

      {movements.data && (
        <>
          <MovementsTable
            movements={movements.data.movements}
            pageKey={`${movements.data.page}|${filters.status}|${filters.assetId}|${filters.originUnitId}|${filters.destinationUnitId}|${filters.from}|${filters.to}|${filters.sort}`}
            busy={movements.isFetching && !movements.isPending}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
            onOpen={(movement) => {
              setSelected(movement);
              setDetailOpen(true);
            }}
          />
          <CatalogPagination
            page={movements.data.page}
            total={movements.data.total}
            pageSize={MOVEMENT_PAGE_SIZE}
            noun="movimentação(ões)"
            loading={movements.isPlaceholderData}
            onPage={filters.setPage}
          />
        </>
      )}

      <MovementDetailSheet
        movement={selected}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        isAdmin={access.isAdmin}
        canWrite={canWrite}
        meId={access.me.data?.id}
      />

      {requestSession > 0 ? (
        <MovementRequestDialog
          key={requestSession}
          open={requestOpen}
          onOpenChange={setRequestOpen}
          units={units.data?.units}
          onCreated={() => undefined}
        />
      ) : null}
    </div>
  );
}
