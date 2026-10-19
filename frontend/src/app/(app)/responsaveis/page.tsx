"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CatalogHeader, CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { PAGE_SIZE } from "@/components/features/catalog/catalog-labels";
import { useCatalogFilters } from "@/components/features/catalog/use-catalog-filters";
import {
  lookupErrorMessage,
  SESSION_ERROR_MESSAGE,
  UNITS_FILTER_ERROR_MESSAGE,
} from "@/components/features/lookup/lookup-labels";
import { PeopleReadTable } from "@/components/features/lookup/lookup-tables";
import { ManageLink } from "@/components/features/lookup/manage-link";
import { noClientRetry, useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { listPeople, type PersonSort } from "@/lib/catalog-api";

// =============================================================================
// /responsaveis — consulta das pessoas responsáveis (todos os perfis, só
// leitura). `GET /api/v1/responsible-people`: para USER o backend devolve só as
// pessoas vinculadas a bens e só `id, name, unit_id, active` — colunas cujas
// chaves não vierem NÃO são exibidas. Telefone (dado pessoal) só aparece se a
// chave vier, sempre mascarado. ADM tem atalho para o cadastro
// (/administracao/responsaveis); aqui não há criar, editar nem inativar.
// =============================================================================

export default function ResponsaveisPage() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const filters = useCatalogFilters<PersonSort>("name");

  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    active: filters.activeParam,
    sort: filters.sort,
    page: filters.page,
    page_size: PAGE_SIZE,
  };
  const people = useQuery({
    queryKey: ["lookup", "people", params],
    queryFn: () => listPeople(params),
    enabled: access.ready,
    placeholderData: keepPreviousData,
    retry: noClientRetry,
  });

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Cadastros · Consulta"
        title="Responsáveis"
        description="Pessoas responsáveis visíveis para o seu perfil e escopo de acesso. Esta tela é somente de consulta."
        action={
          access.isAdmin ? <ManageLink href="/administracao/responsaveis" label="Gerenciar cadastro de responsáveis" /> : null
        }
      />

      <CatalogToolbar
        idPrefix="consulta-responsaveis"
        searchLabel="Buscar pessoa responsável"
        searchPlaceholder="Buscar pessoa responsável…"
        search={filters.search}
        onSearch={filters.setSearch}
        units={{ items: units.data?.units, value: filters.unitId, onChange: filters.chooseUnit }}
        active={{ value: filters.active, onChange: filters.chooseActive }}
        filtered={filters.filtered}
        onClear={filters.clear}
      />

      {access.sessionError ? <CatalogNotice>{SESSION_ERROR_MESSAGE}</CatalogNotice> : null}
      {units.isError ? <CatalogNotice>{UNITS_FILTER_ERROR_MESSAGE}</CatalogNotice> : null}

      {!access.sessionError && (access.me.isPending || people.isPending) && (
        <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando pessoas responsáveis…" />
      )}

      {people.isError && (
        <CatalogNotice onRetry={() => people.refetch()} retrying={people.isFetching}>
          {lookupErrorMessage(people.error, "as pessoas responsáveis")}
        </CatalogNotice>
      )}

      {people.data && (
        <>
          <PeopleReadTable
            people={people.data.people}
            units={units.data?.units}
            pageKey={`${people.data.page}|${filters.q}|${filters.unitId}|${filters.active}|${filters.sort}`}
            busy={people.isFetching && !people.isPending}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
          />
          <CatalogPagination
            page={people.data.page}
            total={people.data.total}
            pageSize={PAGE_SIZE}
            noun="pessoa(s)"
            loading={people.isPlaceholderData}
            onPage={filters.setPage}
          />
        </>
      )}
    </div>
  );
}
