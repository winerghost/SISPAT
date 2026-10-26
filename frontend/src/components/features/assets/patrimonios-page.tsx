"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { fetchAssetBondStatuses, listAssets, type AssetRecord } from "@/lib/assets-api";
import { CatalogHeader, CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { SESSION_ERROR_MESSAGE } from "@/components/features/lookup/lookup-labels";
import { noClientRetry, useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { AssetDetailSheet } from "./asset-detail-sheet";
import { assetsQueryKey, AssetFormDialog } from "./asset-form-dialog";
import { ASSET_LOOKUPS_ERROR_MESSAGE, assetListErrorMessage } from "./asset-labels";
import { AssetsTable, type AssetsEmptyKind } from "./assets-table";
import { AssetsToolbar } from "./assets-toolbar";
import { useAssetFilters } from "./use-asset-filters";
import { useClampPage } from "./use-clamp-page";
import { useUnitPeople, useUnitRooms } from "./use-asset-lookups";

// =============================================================================
// /patrimonios — lista real de bens (`GET /api/v1/assets`).
// Busca (debounce 300 ms), unidade, sala, responsável, "localizado", vínculo, ordenação
// (allowlist) e paginação vão como parâmetros; o BACKEND aplica perfil, escopo de
// unidade e campos por perfil. Esta tela é só apresentação: esconder botões por
// perfil é UX, nunca segurança. Detalhe/edição/exclusão lógica/histórico ficam
// no painel lateral. Nenhum número é animado; o total vem do backend.
// =============================================================================

export function PatrimoniosPage() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const filters = useAssetFilters();
  const roles = access.me.data?.roles ?? [];
  const canWrite = roles.includes("ADM") || roles.includes("USER");

  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSession, setCreateSession] = useState(0);

  const rooms = useUnitRooms(filters.unitId, access.ready, false);
  const people = useUnitPeople(filters.unitId, access.ready, false);

  // Opções do filtro "Vínculo": falha aqui só desativa o filtro (a lista segue).
  const bondStatuses = useQuery({
    queryKey: [...assetsQueryKey, "bond-statuses"],
    queryFn: fetchAssetBondStatuses,
    enabled: access.ready,
    retry: noClientRetry,
  });

  const includeDeleted = access.isAdmin && filters.includeDeleted;
  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    room_id: filters.roomId || undefined,
    responsible_person_id: filters.personId || undefined,
    located: filters.located || undefined,
    bond_status: filters.bondStatus || undefined,
    include_deleted: includeDeleted || undefined,
    sort: filters.sort,
    page: filters.pg.page,
    page_size: filters.pg.pageSize,
  };
  const assets = useQuery({
    queryKey: [...assetsQueryKey, "list", params],
    queryFn: () => listAssets(params),
    enabled: access.ready,
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });

  useClampPage(filters.pg, assets.data?.total, !assets.isPlaceholderData);

  // Vazio: nunca afirmar "nenhum bem" com dado provisório; distingue sem unidades
  // (escopo do backend em `units/accessible`), filtros sem resultado e escopo sem bens.
  // Página vazia com total > 0 = página além da última, sendo ajustada por useClampPage.
  const emptyKind: AssetsEmptyKind =
    assets.isPlaceholderData || (assets.data && assets.data.total > 0 && assets.data.assets.length === 0)
    ? "loading"
    : units.data && units.data.units.length === 0
      ? "no-scope"
      : filters.filtered
        ? "filtered"
        : "none";

  const lookupsFailed =units.isError || rooms.isError || people.isError;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Patrimônio"
        title="Patrimônios"
        description={
          canWrite || !access.ready
            ? "Bens patrimoniais das unidades do seu escopo de acesso. O número patrimonial é sempre tratado como texto."
            : "Bens patrimoniais das unidades do seu escopo de acesso. Seu perfil é somente de consulta."
        }
        action={
          canWrite ? (
            <Button
              onClick={() => {
                setCreateSession((n) => n + 1);
                setCreateOpen(true);
              }}
            >
              Novo bem
            </Button>
          ) : null
        }
      />

      <AssetsToolbar
        filters={filters}
        units={units.data?.units}
        rooms={rooms.data?.rooms}
        people={people.data?.people}
        bondStatuses={bondStatuses.data?.items}
        bondStatusesFailed={bondStatuses.isError}
        isAdmin={access.isAdmin}
      />

      {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}
      {lookupsFailed && !assets.isError ? <CatalogNotice>{ASSET_LOOKUPS_ERROR_MESSAGE}</CatalogNotice> : null}

      {!access.sessionError && (access.me.isPending || assets.isPending) && (
        <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando bens…" />
      )}

      {assets.isError && (
        <CatalogNotice onRetry={() => assets.refetch()} retrying={assets.isFetching}>
          {assetListErrorMessage(assets.error)}
        </CatalogNotice>
      )}

      {assets.data && (
        <>
          <AssetsTable
            assets={assets.data.assets}
            pageKey={`${assets.data.page}|${assets.data.page_size}|${filters.q}|${filters.unitId}|${filters.roomId}|${filters.personId}|${filters.located}|${filters.bondStatus}|${includeDeleted}|${filters.sort}`}
            busy={assets.isFetching && !assets.isPending}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            emptyKind={emptyKind}
            onOpen={(asset) => {
              setSelected(asset);
              setDetailOpen(true);
            }}
          />
          <PaginationBar
            page={filters.pg.page}
            pageSize={filters.pg.pageSize}
            total={assets.data.total}
            onPageChange={filters.pg.setPage}
            onPageSizeChange={filters.pg.setPageSize}
            busy={assets.isPlaceholderData}
            noun="bem(ns)"
          />
        </>
      )}

      <AssetDetailSheet
        asset={selected}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        isAdmin={access.isAdmin}
        canWrite={canWrite}
        units={units.data?.units}
      />

      {createSession > 0 ? (
        <AssetFormDialog
          key={createSession}
          open={createOpen}
          onOpenChange={setCreateOpen}
          asset={null}
          isAdmin={access.isAdmin}
          units={units.data?.units}
          defaultUnitId={filters.unitId}
          conflict={false}
          onConflict={() => undefined}
          onSaved={() => undefined}
        />
      ) : null}
    </div>
  );
}
