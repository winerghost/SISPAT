"use client";

import { useMemo } from "react";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CatalogHeader, CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { PAGE_SIZE } from "@/components/features/catalog/catalog-labels";
import { useCatalogFilters } from "@/components/features/catalog/use-catalog-filters";
import {
  lookupErrorMessage,
  normalizeSearch,
  SESSION_ERROR_MESSAGE,
} from "@/components/features/lookup/lookup-labels";
import { UnitsReadTable } from "@/components/features/lookup/lookup-tables";
import { ManageLink } from "@/components/features/lookup/manage-link";
import { useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import type { UnitSort } from "@/lib/catalog-api";

// =============================================================================
// /unidades — consulta das unidades do escopo do usuário (todos os perfis).
// Fonte: `GET /api/v1/units/accessible` (sem parâmetros). O contrato devolve a
// lista inteira do escopo, então busca, situação, ordenação e paginação de 25
// são feitas aqui, sobre dados já autorizados pelo backend. Somente leitura;
// ADM tem atalho para o cadastro (/administracao/unidades).
// =============================================================================

export default function UnidadesPage() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const filters = useCatalogFilters<UnitSort>("code");

  const filteredUnits = useMemo(() => {
    const term = normalizeSearch(filters.q);
    const field = filters.sort.replace(/^-/, "") as "code" | "name";
    const dir = filters.sort.startsWith("-") ? -1 : 1;
    return (units.data?.units ?? [])
      .filter(
        (unit) =>
          (!term || normalizeSearch(unit.code).includes(term) || normalizeSearch(unit.name).includes(term)) &&
          (filters.activeParam === undefined || unit.active === filters.activeParam),
      )
      .sort((a, b) => a[field].localeCompare(b[field], "pt-BR") * dir || a.id.localeCompare(b.id));
  }, [units.data, filters.q, filters.sort, filters.activeParam]);

  const totalPages = Math.max(1, Math.ceil(filteredUnits.length / PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const pageItems = filteredUnits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Cadastros · Consulta"
        title="Unidades"
        description="Unidades do seu escopo de acesso. Esta tela é somente de consulta."
        action={access.isAdmin ? <ManageLink href="/administracao/unidades" label="Gerenciar cadastro de unidades" /> : null}
      />

      <CatalogToolbar
        idPrefix="consulta-unidades"
        searchLabel="Buscar unidade por sigla ou nome"
        searchPlaceholder="Buscar por sigla ou nome…"
        search={filters.search}
        onSearch={filters.setSearch}
        active={{ value: filters.active, onChange: filters.chooseActive }}
        filtered={filters.filtered}
        onClear={filters.clear}
      />

      {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}

      {!access.sessionError && (access.me.isPending || units.isPending) && (
        <LoadingSkeleton variant="table" count={4} columns={3} label="Carregando unidades…" />
      )}

      {units.isError && (
        <CatalogNotice onRetry={() => units.refetch()} retrying={units.isFetching}>
          {lookupErrorMessage(units.error, "as unidades")}
        </CatalogNotice>
      )}

      {units.data && (
        <>
          <UnitsReadTable
            units={pageItems}
            pageKey={`${page}|${filters.q}|${filters.active}|${filters.sort}`}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
          />
          <CatalogPagination
            page={page}
            total={filteredUnits.length}
            pageSize={PAGE_SIZE}
            noun="unidade(s)"
            loading={false}
            onPage={filters.setPage}
          />
        </>
      )}
    </div>
  );
}
