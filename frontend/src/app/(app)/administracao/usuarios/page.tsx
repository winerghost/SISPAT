"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import { selectControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { InviteUserDialog } from "@/components/features/users/invite-user-dialog";
import { unitLabel, useUnits } from "@/components/features/users/unit-checkbox-list";
import { UserDetailSheet } from "@/components/features/users/user-detail-sheet";
import { AAL2_MESSAGE, errorCode } from "@/components/features/users/user-labels";
import { UsersTable } from "@/components/features/users/users-table";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { useMe } from "@/lib/session";
import { ApiError, listUsers, USER_ROLES, type UserRole, type UserSort, type UserSummary } from "@/lib/users-api";
import { rateLimitMessage } from "@/lib/api-errors";
import { usePagination } from "@/lib/pagination";

// =============================================================================
// /administracao/usuarios — gestão de usuários (ADM).
// =============================================================================
// Lista: `GET /api/v1/users` com busca (debounce), filtros (perfil, unidade,
// ativo), ordenação (allowlist) e paginação — tudo resolvido no backend, que
// também aplica o escopo de unidade do ADM. Detalhe/edição em painel lateral
// (`UserDetailSheet`); convite em `InviteUserDialog`.
// Ocultar a página no menu para USER/RH é só UX: o backend nega (403).
// Paginação/filtro: os resultados anteriores ficam visíveis (esmaecidos,
// aria-busy) até a próxima resposta chegar.
// =============================================================================

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX = 100;

type ActiveFilter = "all" | "true" | "false";

export default function AdministracaoUsuariosPage() {
  const me = useMe();
  // Negar por padrão (UX): dados administrativos só são pedidos depois que
  // `/me` confirma o papel ADM. Quem autoriza de fato é o backend (403).
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const meDenied = me.isError || (me.isSuccess && !isAdmin);
  const units = useUnits(isAdmin);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<UserRole | undefined>(undefined);
  const [unitId, setUnitId] = useState("");
  const [active, setActive] = useState<ActiveFilter>("all");
  const [sort, setSort] = useState<UserSort>("name");
  const pg = usePagination();
  const resetPage = pg.resetPage;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(search.trim());
      resetPage();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, resetPage]);

  const params = {
    q: q || undefined,
    role,
    unit_id: unitId || undefined,
    active: active === "all" ? undefined : active === "true",
    sort,
    page: pg.page,
    page_size: pg.pageSize,
  };

  const usersQuery = useQuery({
    queryKey: ["users", "list", params],
    queryFn: () => listUsers(params),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

  const filtered = !!q || !!role || !!unitId || active !== "all";
  const busy = usersQuery.isFetching && !usersQuery.isPending;
  function withReset<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      resetPage();
    };
  }
  const chooseRole = withReset(setRole);
  const chooseActive = withReset(setActive);
  const chooseUnit = withReset(setUnitId);
  const chooseSort = withReset(setSort);

  function clearFilters() {
    setSearch("");
    setQ("");
    setRole(undefined);
    setUnitId("");
    setActive("all");
    resetPage();
  }

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-eyebrow text-pale-stone">Administração</span>
          <h1 className="text-heading text-bone">Usuários</h1>
          <p className="max-w-page text-body-sm text-warm-granite">
            Convide pessoas, ajuste perfis e unidades, e gerencie contas, fotos e histórico.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>Convidar Usuário</Button>
      </div>

      <section aria-label="Busca e filtros" className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
          <div className="relative w-full md:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Buscar por nome ou e-mail"
              placeholder="Buscar por nome ou e-mail…"
              maxLength={SEARCH_MAX}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex w-full flex-col gap-1.5 md:w-64">
            <label htmlFor="filtro-unidade" className="text-eyebrow text-pale-stone">
              Unidade
            </label>
            <select
              id="filtro-unidade"
              className={selectControlClassName}
              value={unitId}
              disabled={!units.data}
              onChange={(event) => chooseUnit(event.target.value)}
            >
              <option value="">Todas as unidades</option>
              {units.data?.units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por perfil">
            <span className="text-eyebrow text-pale-stone" aria-hidden="true">
              Perfil
            </span>
            <FilterPill label="Todos" active={role === undefined} onClick={() => chooseRole(undefined)} />
            {USER_ROLES.map((option) => (
              <FilterPill key={option} label={option} active={role === option} onClick={() => chooseRole(option)} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por situação">
            <span className="text-eyebrow text-pale-stone" aria-hidden="true">
              Situação
            </span>
            <FilterPill label="Todas" active={active === "all"} onClick={() => chooseActive("all")} />
            <FilterPill label="Ativos" active={active === "true"} onClick={() => chooseActive("true")} />
            <FilterPill label="Inativos" active={active === "false"} onClick={() => chooseActive("false")} />
          </div>
          {filtered ? (
            <Button variant="link" size="sm" className="min-h-8" onClick={clearFilters}>
              Limpar filtros
            </Button>
          ) : null}
        </div>
      </section>

      {meDenied ? (
        <SlideIn distance="sm">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>
              {me.isError
                ? "Não foi possível confirmar sua sessão. Entre novamente."
                : "Você não tem permissão para visualizar usuários. É necessário o papel ADM com a permissão de gestão de usuários."}
            </FormMessage>
          </div>
        </SlideIn>
      ) : null}

      {!meDenied && usersQuery.isPending && (
        <LoadingSkeleton variant="table" count={5} columns={6} label="Carregando usuários…" />
      )}

      {usersQuery.isError && (
        <SlideIn distance="sm">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>{listErrorMessage(usersQuery.error)}</FormMessage>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={usersQuery.isFetching}
              onClick={() => usersQuery.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      )}

      {usersQuery.data && (
        <>
          <UsersTable
            users={usersQuery.data.users}
            pageKey={`${usersQuery.data.page}|${usersQuery.data.page_size}|${q}|${role ?? ""}|${unitId}|${active}|${sort}`}
            busy={busy}
            sort={sort}
            onSortChange={chooseSort}
            filtered={filtered}
            onManage={(user) => {
              setSelected(user);
              setSheetOpen(true);
            }}
          />

          <PaginationBar
            page={pg.page}
            pageSize={pg.pageSize}
            total={usersQuery.data.total}
            onPageChange={pg.setPage}
            onPageSizeChange={pg.setPageSize}
            busy={usersQuery.isFetching}
            noun="usuário(s)"
          />
        </>
      )}

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <UserDetailSheet
        user={selected}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        currentUserId={me.data?.id}
      />
    </div>
  );
}

function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
    if (error.status === 403 && errorCode(error) === "aal2_required") return AAL2_MESSAGE;
    if (error.status === 403) {
      return "Você não tem permissão para visualizar usuários. É necessário o papel ADM com a permissão de gestão de usuários.";
    }
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 400) return "A busca ou os filtros não foram aceitos. Limpe os filtros e tente novamente.";
  }
  return "Não foi possível carregar a lista de usuários. Tente novamente.";
}
