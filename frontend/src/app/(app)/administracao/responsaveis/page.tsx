"use client";

import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CatalogHeader, CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { CatalogToolbar } from "@/components/features/catalog/catalog-toolbar";
import { PeopleTable } from "@/components/features/catalog/catalog-tables";
import {
  catalogListErrorMessage,
  DENIED_MESSAGE,
  PAGE_SIZE,
} from "@/components/features/catalog/catalog-labels";
import { PersonFormDialog, peopleQueryKey } from "@/components/features/catalog/person-form-dialog";
import { useActiveToggle } from "@/components/features/catalog/use-active-toggle";
import { useCatalogFilters } from "@/components/features/catalog/use-catalog-filters";
import { useUnits } from "@/components/features/users/unit-checkbox-list";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { ApiError, listPeople, setPersonActive, type PersonRecord, type PersonSort } from "@/lib/catalog-api";
import { useMe } from "@/lib/session";

// =============================================================================
// /administracao/responsaveis — cadastro de pessoas responsáveis (ADM).
// Mesmo padrão de /administracao/salas. Particularidades (LGPD): o telefone só
// aparece quando o backend envia a chave `phone` (somente ADM) e é exibido
// mascarado; nada disso é logado. "Excluir" = Inativar (registro preservado).
// =============================================================================

export default function AdministracaoResponsaveisPage() {
  const me = useMe();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const meDenied = me.isError || (me.isSuccess && !isAdmin);
  const units = useUnits(isAdmin);
  const queryClient = useQueryClient();
  const filters = useCatalogFilters<PersonSort>("name");
  const [form, setForm] = useState<{ session: number; person: PersonRecord | null; open: boolean }>({
    session: 0,
    person: null,
    open: false,
  });

  const params = {
    q: filters.q || undefined,
    unit_id: filters.unitId || undefined,
    active: filters.activeParam,
    sort: filters.sort,
    page: filters.page,
    page_size: PAGE_SIZE,
  };
  const peopleQuery = useQuery({
    queryKey: [...peopleQueryKey, "list", params],
    queryFn: () => listPeople(params),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

  const toggle = useActiveToggle<PersonRecord>({
    noun: "pessoa responsável",
    request: setPersonActive,
    onDone: () => void queryClient.invalidateQueries({ queryKey: peopleQueryKey }),
  });

  function openForm(person: PersonRecord | null) {
    setForm((prev) => ({ session: prev.session + 1, person, open: true }));
  }

  const busy = peopleQuery.isFetching && !peopleQuery.isPending;
  const changing = peopleQuery.isPlaceholderData;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        title="Pessoas Responsáveis"
        description="Cadastre e edite as pessoas responsáveis por bens. Não há exclusão: inativar preserva o registro e os bens já vinculados."
        action={
          <Button disabled={!isAdmin} onClick={() => openForm(null)}>
            Nova pessoa
          </Button>
        }
      />

      <CatalogToolbar
        idPrefix="pessoas"
        searchLabel="Buscar pessoa por nome ou e-mail"
        searchPlaceholder="Buscar por nome ou e-mail…"
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

      {!meDenied && peopleQuery.isPending && (
        <LoadingSkeleton variant="table" count={5} columns={6} label="Carregando pessoas responsáveis…" />
      )}

      {peopleQuery.isError && (
        <CatalogNotice onRetry={() => peopleQuery.refetch()} retrying={peopleQuery.isFetching}>
          {catalogListErrorMessage(peopleQuery.error, "pessoa responsável")}
        </CatalogNotice>
      )}

      {peopleQuery.data && (
        <>
          <PeopleTable
            people={peopleQuery.data.people}
            units={units.data?.units}
            pageKey={`${peopleQuery.data.page}|${filters.q}|${filters.unitId}|${filters.active}|${filters.sort}`}
            busy={busy}
            sort={filters.sort}
            onSortChange={filters.chooseSort}
            filtered={filters.filtered}
            onEdit={openForm}
            onToggle={toggle.ask}
          />
          <CatalogPagination
            page={peopleQuery.data.page}
            total={peopleQuery.data.total}
            pageSize={PAGE_SIZE}
            noun="pessoa(s)"
            loading={changing}
            onPage={filters.setPage}
          />
        </>
      )}

      <PersonFormDialog
        key={form.session}
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
        person={form.person}
        units={units.data?.units}
        defaultUnitId={filters.unitId}
      />
      {toggle.dialog}
    </div>
  );
}
