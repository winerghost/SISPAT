"use client";

import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { CatalogHeader, CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { RoomsTable } from "@/components/features/catalog/catalog-tables";
import {
  catalogListErrorMessage,
  DENIED_MESSAGE,
} from "@/components/features/catalog/catalog-labels";
import { RoomFormDialog, roomsQueryKey } from "@/components/features/catalog/room-form-dialog";
import { useActiveToggle } from "@/components/features/catalog/use-active-toggle";
import { useCatalogFilters, useClampPage } from "@/components/features/catalog/use-catalog-filters";
import { useUnits } from "@/components/features/users/unit-checkbox-list";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { ApiError, listRooms, setRoomActive, type RoomRecord, type RoomSort } from "@/lib/catalog-api";
import { useMe } from "@/lib/session";

// =============================================================================
// /administracao/salas — cadastro de salas (ADM).
// Lista: `GET /api/v1/rooms` com busca (debounce), unidade, situação, ordenação
// (allowlist) e paginação — tudo resolvido no backend, que aplica o escopo de
// unidade. Criar/editar em diálogo; "Excluir" = Inativar (o registro é
// preservado) com confirmação. Ocultar a página para USER/RH é só UX: o backend
// nega (403).
// =============================================================================

export default function AdministracaoSalasPage() {
  const me = useMe();
  // Negar por padrão (UX): dados só são pedidos depois que `/me` confirma o ADM.
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const meDenied = me.isError || (me.isSuccess && !isAdmin);
  const units = useUnits(isAdmin);
  const queryClient = useQueryClient();
  const filters = useCatalogFilters<RoomSort>("name");
  const [form, setForm] = useState<{ session: number; room: RoomRecord | null; open: boolean }>({
    session: 0,
    room: null,
    open: false,
  });

  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    active: filters.activeParam,
    sort: filters.sort,
    page: filters.page,
    page_size: filters.pageSize,
  };
  const roomsQuery = useQuery({
    queryKey: [...roomsQueryKey, "list", params],
    queryFn: () => listRooms(params),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

  const toggle = useActiveToggle<RoomRecord>({
    noun: "sala",
    request: setRoomActive,
    onDone: () => void queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
  });

  function openForm(room: RoomRecord | null) {
    setForm((prev) => ({ session: prev.session + 1, room, open: true }));
  }

  const busy = roomsQuery.isFetching && !roomsQuery.isPending;
  const changing = roomsQuery.isPlaceholderData;

  useClampPage(filters.pg, roomsQuery.data?.total, !roomsQuery.isPlaceholderData);

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        title="Salas"
        description="Cadastre e edite as salas de cada unidade. Não há exclusão: inativar preserva o registro e os bens já vinculados."
        action={
          <Button disabled={!isAdmin} onClick={() => openForm(null)}>
            Nova sala
          </Button>
        }
      />

      <CatalogToolbar
        idPrefix="salas"
        searchLabel="Buscar sala por nome ou andar"
        searchPlaceholder="Buscar por nome ou andar…"
        search={filters.search}
        onSearch={filters.setSearch}
        units={{ items: units.data?.units, value: filters.unitId, onChange: filters.chooseUnit }}
        active={{ value: filters.active, onChange: filters.chooseActive }}
        filtered={filters.filtered}
        onClear={filters.clear}
      />

      {meDenied ? (
        <CatalogNotice>
          {me.isError ? "Não foi possível confirmar sua sessão. Entre novamente." : DENIED_MESSAGE}
        </CatalogNotice>
      ) : null}

      {!meDenied && roomsQuery.isPending && (
        <LoadingSkeleton variant="table" count={5} columns={6} label="Carregando salas…" />
      )}

      {roomsQuery.isError && (
        <CatalogNotice onRetry={() => roomsQuery.refetch()} retrying={roomsQuery.isFetching}>
          {catalogListErrorMessage(roomsQuery.error, "sala")}
        </CatalogNotice>
      )}

      {roomsQuery.data && (
        <>
          <RoomsTable
            rooms={roomsQuery.data.rooms}
            units={units.data?.units}
            pageKey={`${roomsQuery.data.page}|${filters.pageSize}|${filters.q}|${filters.unitId}|${filters.active}|${filters.sort}`}
            busy={busy}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
            onEdit={openForm}
            onToggle={toggle.ask}
          />
          <PaginationBar
            page={filters.page}
            pageSize={filters.pageSize}
            total={roomsQuery.data.total}
            onPageChange={filters.setPage}
            onPageSizeChange={filters.setPageSize}
            busy={changing}
          />
        </>
      )}

      <RoomFormDialog
        key={form.session}
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
        room={form.room}
        units={units.data?.units}
        defaultUnitId={filters.unitId}
      />
      {toggle.dialog}
    </div>
  );
}
