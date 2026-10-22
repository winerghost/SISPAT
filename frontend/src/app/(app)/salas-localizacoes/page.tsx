"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { CatalogHeader, CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { useCatalogFilters, useClampPage } from "@/components/features/catalog/use-catalog-filters";
import {
  lookupErrorMessage,
  SESSION_ERROR_MESSAGE,
  UNITS_FILTER_ERROR_MESSAGE,
} from "@/components/features/lookup/lookup-labels";
import { RoomsReadTable } from "@/components/features/lookup/lookup-tables";
import { ManageLink } from "@/components/features/lookup/manage-link";
import { noClientRetry, useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { listRooms, type RoomSort } from "@/lib/catalog-api";

// =============================================================================
// /salas-localizacoes — consulta das salas (todos os perfis, só leitura).
// `GET /api/v1/rooms` com busca (debounce), unidade, situação, ordenação
// (allowlist) e paginação resolvidas no backend, que aplica perfil e escopo de
// unidade. Colunas opcionais só aparecem se a chave veio. ADM tem atalho para o
// cadastro (/administracao/salas); aqui não há criar, editar nem inativar.
// =============================================================================

export default function SalasLocalizacoesPage() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const filters = useCatalogFilters<RoomSort>("name");

  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    active: filters.activeParam,
    sort: filters.sort,
    page: filters.page,
    page_size: filters.pageSize,
  };
  const rooms = useQuery({
    queryKey: ["lookup", "rooms", params],
    queryFn: () => listRooms(params),
    enabled: access.ready,
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });

  useClampPage(filters.pg, rooms.data?.total, !rooms.isPlaceholderData);

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Cadastros · Consulta"
        title="Salas e Localizações"
        description="Salas das unidades do seu escopo de acesso. Esta tela é somente de consulta."
        action={access.isAdmin ? <ManageLink href="/administracao/salas" label="Gerenciar cadastro de salas" /> : null}
      />

      <CatalogToolbar
        idPrefix="consulta-salas"
        searchLabel="Buscar sala por nome ou andar"
        searchPlaceholder="Buscar por nome ou andar…"
        search={filters.search}
        onSearch={filters.setSearch}
        units={{ items: units.data?.units, value: filters.unitId, onChange: filters.chooseUnit }}
        active={{ value: filters.active, onChange: filters.chooseActive }}
        filtered={filters.filtered}
        onClear={filters.clear}
      />

      {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}
      {units.isError ? <CatalogNotice>{UNITS_FILTER_ERROR_MESSAGE}</CatalogNotice> : null}

      {!access.sessionError && (access.me.isPending || rooms.isPending) && (
        <LoadingSkeleton variant="table" count={5} columns={5} label="Carregando salas…" />
      )}

      {rooms.isError && (
        <CatalogNotice onRetry={() => rooms.refetch()} retrying={rooms.isFetching}>
          {lookupErrorMessage(rooms.error, "as salas")}
        </CatalogNotice>
      )}

      {rooms.data && (
        <>
          <RoomsReadTable
            rooms={rooms.data.rooms}
            units={units.data?.units}
            pageKey={`${rooms.data.page}|${filters.pageSize}|${filters.q}|${filters.unitId}|${filters.active}|${filters.sort}`}
            busy={rooms.isFetching && !rooms.isPending}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
          />
          <PaginationBar
            page={filters.page}
            pageSize={filters.pageSize}
            total={rooms.data.total}
            onPageChange={filters.setPage}
            onPageSizeChange={filters.setPageSize}
            busy={rooms.isPlaceholderData}
          />
        </>
      )}
    </div>
  );
}
