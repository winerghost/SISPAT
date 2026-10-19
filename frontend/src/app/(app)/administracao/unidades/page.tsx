"use client";

import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CatalogHeader, CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { UnitsTable } from "@/components/features/catalog/catalog-tables";
import { catalogListErrorMessage, DENIED_MESSAGE, PAGE_SIZE } from "@/components/features/catalog/catalog-labels";
import { UnitFormDialog } from "@/components/features/catalog/unit-form-dialog";
import { useActiveToggle } from "@/components/features/catalog/use-active-toggle";
import { useCatalogFilters } from "@/components/features/catalog/use-catalog-filters";
import { UNITS_QUERY_KEY } from "@/components/features/users/unit-checkbox-list";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import {
  ApiError,
  listUnitsCatalog,
  setUnitActive,
  type UnitCatalogItem,
  type UnitSort,
} from "@/lib/catalog-api";
import { useMe } from "@/lib/session";

// =============================================================================
// /administracao/unidades — cadastro de unidades (ADM).
// A listagem vem de `GET /api/v1/units/catalog` (ADM + AAL2): ativas e
// inativas, com busca (debounce), situação, ordenação (allowlist) e paginação
// resolvidas no backend, que também aplica o escopo de unidade. Inativar e
// reativar funcionam direto na linha (inclusive para inativas) ou no diálogo.
// O seletor de unidades das outras telas segue em `GET /api/v1/units`.
// Não há criação nem exclusão.
// =============================================================================

const unitsListKey = ["catalog", "units", "list"] as const;

export default function AdministracaoUnidadesPage() {
  const me = useMe();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const meDenied = me.isError || (me.isSuccess && !isAdmin);
  const queryClient = useQueryClient();
  const filters = useCatalogFilters<UnitSort>("name");
  const [form, setForm] = useState<{ session: number; unit: UnitCatalogItem | null; open: boolean }>({
    session: 0,
    unit: null,
    open: false,
  });

  const params = {
    q: filters.q || undefined,
    active: filters.activeParam,
    sort: filters.sort,
    page: filters.page,
    page_size: PAGE_SIZE,
  };
  const unitsQuery = useQuery({
    queryKey: [...unitsListKey, params],
    queryFn: () => listUnitsCatalog(params),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

  const toggle = useActiveToggle<UnitCatalogItem>({
    noun: "unidade",
    request: setUnitActive,
    onDone: () => {
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      void queryClient.invalidateQueries({ queryKey: UNITS_QUERY_KEY });
    },
  });

  const busy = unitsQuery.isFetching && !unitsQuery.isPending;
  const changing = unitsQuery.isPlaceholderData;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        title="Unidades"
        description="Edite os dados cadastrais das unidades do seu escopo e reative as inativas. A sigla e o ID de origem são imutáveis; não há exclusão — inativar preserva o registro."
      />

      <CatalogToolbar
        idPrefix="unidades"
        searchLabel="Buscar unidade por sigla ou nome"
        searchPlaceholder="Buscar por sigla ou nome…"
        search={filters.search}
        onSearch={filters.setSearch}
        active={{ value: filters.active, onChange: filters.chooseActive }}
        filtered={filters.filtered}
        onClear={filters.clear}
      />

      {meDenied ? (
        <CatalogNotice>
          {me.isError ? "Não foi possível confirmar sua sessão. Entre novamente." : DENIED_MESSAGE}
        </CatalogNotice>
      ) : null}

      {!meDenied && unitsQuery.isPending && (
        <LoadingSkeleton variant="table" count={4} columns={5} label="Carregando unidades…" />
      )}

      {unitsQuery.isError && (
        <CatalogNotice onRetry={() => unitsQuery.refetch()} retrying={unitsQuery.isFetching}>
          {catalogListErrorMessage(unitsQuery.error, "unidade")}
        </CatalogNotice>
      )}

      {unitsQuery.data && (
        <>
          <UnitsTable
            units={unitsQuery.data.units}
            pageKey={`${unitsQuery.data.page}|${filters.q}|${filters.active}|${filters.sort}`}
            busy={busy}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
            onEdit={(unit) => setForm((prev) => ({ session: prev.session + 1, unit, open: true }))}
            onToggle={toggle.ask}
          />
          <CatalogPagination
            page={unitsQuery.data.page}
            total={unitsQuery.data.total}
            pageSize={PAGE_SIZE}
            noun="unidade(s)"
            loading={changing}
            onPage={filters.setPage}
          />
        </>
      )}

      <UnitFormDialog
        key={form.session}
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
        unit={form.unit}
      />
      {toggle.dialog}
    </div>
  );
}
