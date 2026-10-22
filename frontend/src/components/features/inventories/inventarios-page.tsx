"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { listInventories, type InventoryRecord } from "@/lib/inventories-api";
import { CatalogHeader, CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { useClampPage } from "@/components/features/assets/use-clamp-page";
import { SESSION_ERROR_MESSAGE } from "@/components/features/lookup/lookup-labels";
import { noClientRetry, useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { AccessRestrictedPanel } from "@/components/features/modules/access-restricted";
import { InventoriesTable } from "./inventories-table";
import { InventoriesToolbar } from "./inventories-toolbar";
import { InventoryCreateDialog } from "./inventory-create-dialog";
import { InventoryDetailSheet } from "./inventory-detail-sheet";
import {
  INVENTORY_LOOKUPS_ERROR_MESSAGE,
  inventoryListErrorMessage,
  inventoryListKey,
  RH_DENIED_MESSAGE,
} from "./inventory-labels";
import { useInventoryFilters } from "./use-inventory-filters";

// =============================================================================
// /inventarios — campanhas de conferência física por unidade
// (`GET /api/v1/inventories`). Estado, unidade, busca por nome, ordenação
// (allowlist) e paginação vão como parâmetros; o BACKEND aplica perfil, escopo de
// unidade e AAL2. Esta tela é só apresentação: esconder botões por perfil é UX,
// nunca segurança. Criar/iniciar/encerrar/cancelar: só ADM. Conferir bem: ADM e
// USER. RH não tem acesso (mensagem fixa, sem chamar a API). Inventários e
// conferências são imutáveis. Nenhum número é animado; totais vêm do backend.
// =============================================================================

export function InventariosPage() {
  const access = useLookupAccess();
  const roles = access.me.data?.roles ?? [];
  const canCheck = roles.includes("ADM") || roles.includes("USER");
  // Negar por padrão: RH (ou perfil desconhecido) nem dispara as consultas.
  const rhDenied = access.ready && !canCheck;
  const enabled = access.ready && canCheck;

  const units = useAccessibleUnits(enabled);
  const filters = useInventoryFilters();

  const [selected, setSelected] = useState<InventoryRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSession, setCreateSession] = useState(0);

  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    status: filters.status || undefined,
    sort: filters.sort,
    page: filters.pg.page,
    page_size: filters.pg.pageSize,
  };
  const inventories = useQuery({
    queryKey: inventoryListKey(params),
    queryFn: () => listInventories(params),
    enabled,
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });

  useClampPage(filters.pg, inventories.data?.total, !inventories.isPlaceholderData);

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Patrimônio"
        title="Inventários"
        description={
          rhDenied
            ? "Conferência física dos bens por unidade."
            : access.isAdmin || !access.ready
              ? "Campanhas de conferência física dos bens, uma por unidade. Inventários e conferências são imutáveis: encerrar ou cancelar é definitivo."
              : "Campanhas de conferência física dos bens por unidade. Você pode conferir bens nos inventários em andamento; criar, iniciar, encerrar e cancelar são ações de administrador."
        }
        action={
          access.isAdmin ? (
            <Button
              onClick={() => {
                setCreateSession((n) => n + 1);
                setCreateOpen(true);
              }}
            >
              Novo inventário
            </Button>
          ) : null
        }
      />

      {rhDenied ? <AccessRestrictedPanel title="Sem acesso aos inventários" message={RH_DENIED_MESSAGE} /> : null}

      {!rhDenied ? (
        <>
          <InventoriesToolbar filters={filters} units={units.data?.units} />

          {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}
          {units.isError && !inventories.isError ? <CatalogNotice>{INVENTORY_LOOKUPS_ERROR_MESSAGE}</CatalogNotice> : null}

          {!access.sessionError && (access.me.isPending || inventories.isPending) && (
            <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando inventários…" />
          )}

          {inventories.isError && (
            <CatalogNotice onRetry={() => inventories.refetch()} retrying={inventories.isFetching}>
              {inventoryListErrorMessage(inventories.error)}
            </CatalogNotice>
          )}

          {inventories.data && (
            <>
              <InventoriesTable
                inventories={inventories.data.inventories}
                pageKey={`${inventories.data.page}|${inventories.data.page_size}|${filters.status}|${filters.unitId}|${filters.q}|${filters.sort}`}
                busy={inventories.isFetching && !inventories.isPending}
                sort={filters.sort}
                onSortChange={filters.chooseSort}
                filtered={filters.filtered}
                onOpen={(inventory) => {
                  setSelected(inventory);
                  setDetailOpen(true);
                }}
              />
              <PaginationBar
                page={filters.pg.page}
                pageSize={filters.pg.pageSize}
                total={inventories.data.total}
                onPageChange={filters.pg.setPage}
                onPageSizeChange={filters.pg.setPageSize}
                busy={inventories.isPlaceholderData}
                noun="inventário(s)"
              />
            </>
          )}

          <InventoryDetailSheet
            inventory={selected}
            open={detailOpen}
            onOpenChange={setDetailOpen}
            isAdmin={access.isAdmin}
            canCheck={canCheck}
          />

          {createSession > 0 ? (
            <InventoryCreateDialog
              key={createSession}
              open={createOpen}
              onOpenChange={setCreateOpen}
              units={units.data?.units}
              onCreated={() => undefined}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
