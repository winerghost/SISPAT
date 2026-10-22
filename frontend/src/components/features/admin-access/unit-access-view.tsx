"use client";

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";

import { CatalogNotice, ActiveBadge } from "@/components/features/catalog/catalog-parts";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import { AccessRestrictedPanel, SESSION_UNCONFIRMED_MESSAGE } from "@/components/features/modules/access-restricted";
import { ManageLink } from "@/components/features/lookup/manage-link";
import { ROLE_LABEL } from "@/components/features/users/user-labels";
import { unitLabel, useUnits } from "@/components/features/users/unit-checkbox-list";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import { selectControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import {
  AnimatedTableBody,
  AnimatedTableRow,
  Table,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminAccessErrorMessage, ApiError, isAccessDenied } from "@/lib/admin-access-api";
import { parsePageSize } from "@/lib/pagination";
import { useMe } from "@/lib/session";
import {
  getUnitAccess,
  parseUnitAccessFilters,
  unitAccessQueryString,
  type UnitAccessActive,
  type UnitAccessFilters,
  type UnitAccessSort,
} from "@/lib/unit-access-api";
import { USER_ROLES, type UserRole } from "@/lib/users-api";

// =============================================================================
// /administracao/vinculos-unidades — consulta SOMENTE LEITURA (ADM).
// Dados de `GET /api/v1/admin/unit-access` (ADM + AAL2 + users.manage; o backend
// já devolve só as unidades do escopo do ADM e nenhum e-mail/telefone). Filtros,
// ordenação e página vivem na URL (link compartilhável) com parse defensivo;
// 401/403 viram "acesso restrito" com texto fixo. Alterar perfil/unidades de um
// usuário continua na tela Usuários (PATCH /users/<id>).
// =============================================================================

const DENIED_MESSAGE =
  "Você não tem permissão para consultar os vínculos de unidades. É necessário o perfil ADM com a verificação em duas etapas concluída.";

const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

function useUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.toString();
  const filters = useMemo(() => parseUnitAccessFilters(new URLSearchParams(raw)), [raw]);
  const canonical = unitAccessQueryString(filters);

  const write = useCallback(
    (query: string) => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }),
    [router, pathname],
  );

  // URL com chave/valor inválido, repetido ou fora de ordem: normaliza.
  useEffect(() => {
    if (raw !== canonical) write(canonical);
  }, [raw, canonical, write]);

  /** Mudar filtro/ordem volta à página 1; só `page` preserva a página. */
  const update = useCallback(
    (patch: Partial<UnitAccessFilters>) => {
      const next = { ...filters, ...patch };
      // Filtro/ordem/tamanho de página voltam à página 1; só `page` preserva a página.
      if (!("page" in patch)) next.page = 1;
      write(unitAccessQueryString(next));
    },
    [filters, write],
  );
  // Limpar filtros preserva o tamanho de página escolhido.
  const clear = useCallback(
    () => write(unitAccessQueryString({ sort: "name", page: 1, page_size: filters.page_size })),
    [write, filters.page_size],
  );
  return { filters, update, clear, filtered: !!filters.unit_id || !!filters.role || !!filters.active };
}

export function UnitAccessView() {
  const me = useMe();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const { filters, update, clear, filtered } = useUrlFilters();
  const units = useUnits(isAdmin);

  const query = useQuery({
    queryKey: ["admin-access", "unit-access", filters],
    queryFn: () => getUnitAccess(filters),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry,
  });

  let body: ReactNode;
  if (me.isPending) {
    body = <LoadingSkeleton variant="lines" count={3} label="Verificando permissões…" />;
  } else if (me.isError) {
    body = <AccessRestrictedPanel message={SESSION_UNCONFIRMED_MESSAGE} />;
  } else if (!isAdmin || isAccessDenied(query.error)) {
    body = isAdmin ? <AccessRestrictedPanel message={DENIED_MESSAGE} /> : <AccessRestrictedPanel />;
  } else {
    body = (
      <>
        <Toolbar
          filters={filters}
          filtered={filtered}
          units={units.data?.units}
          unitsFailed={units.isError}
          onChange={update}
          onClear={clear}
        />
        {query.isError ? (
          <CatalogNotice onRetry={() => void query.refetch()} retrying={query.isFetching}>
            {query.error instanceof ApiError && query.error.status === 400
              ? "Os filtros não foram aceitos. Limpe os filtros e tente novamente."
              : adminAccessErrorMessage(query.error, "os vínculos de unidades")}
          </CatalogNotice>
        ) : query.isPending ? (
          <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando vínculos…" />
        ) : (
          <>
            <AccessTable
              items={query.data.items}
              sort={filters.sort}
              filtered={filtered}
              busy={query.isFetching}
              pageKey={`${query.data.page}|${query.data.page_size}|${unitAccessQueryString({ ...filters, page: 1 })}`}
              onSort={(sort) => update({ sort })}
            />
            <PaginationBar
              page={filters.page}
              pageSize={filters.page_size}
              total={query.data.total}
              noun="usuário(s)"
              busy={query.isFetching}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(size) => update({ page_size: parsePageSize(size) })}
            />
          </>
        )}
      </>
    );
  }
  return <>{body}</>;
}

function Toolbar({
  filters,
  filtered,
  units,
  unitsFailed,
  onChange,
  onClear,
}: {
  filters: UnitAccessFilters;
  filtered: boolean;
  units: { id: string; code: string; name: string }[] | undefined;
  unitsFailed: boolean;
  onChange: (patch: Partial<UnitAccessFilters>) => void;
  onClear: () => void;
}) {
  const known = !filters.unit_id || !!units?.some((unit) => unit.id === filters.unit_id);
  return (
    <section aria-label="Filtros" className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
        <div className="flex w-full flex-col gap-1.5 md:w-72">
          <label htmlFor="vinculos-filtro-unidade" className="text-eyebrow text-pale-stone">
            Unidade
          </label>
          <select
            id="vinculos-filtro-unidade"
            className={selectControlClassName}
            value={filters.unit_id ?? ""}
            disabled={!units && !filters.unit_id}
            onChange={(event) => onChange({ unit_id: event.target.value || undefined })}
          >
            <option value="">Todas as unidades</option>
            {units?.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unitLabel(unit)}
              </option>
            ))}
            {!known ? <option value={filters.unit_id}>Unidade do link</option> : null}
          </select>
          {unitsFailed ? (
            <span className="text-caption text-warm-granite">Lista de unidades indisponível no momento.</span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por perfil">
          <span className="text-eyebrow text-pale-stone" aria-hidden="true">
            Perfil
          </span>
          <FilterPill label="Todos" active={!filters.role} onClick={() => onChange({ role: undefined })} />
          {USER_ROLES.map((role) => (
            <FilterPill key={role} label={role} active={filters.role === role} onClick={() => onChange({ role })} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por situação">
          <span className="text-eyebrow text-pale-stone" aria-hidden="true">
            Situação
          </span>
          {(
            [
              [undefined, "Todos"],
              ["true", "Ativos"],
              ["false", "Inativos"],
            ] as [UnitAccessActive | undefined, string][]
          ).map(([value, label]) => (
            <FilterPill key={label} label={label} active={filters.active === value} onClick={() => onChange({ active: value })} />
          ))}
        </div>
        {filtered ? (
          <Button variant="link" size="sm" className="min-h-8" onClick={onClear}>
            Limpar filtros
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function RoleBadge({ role }: { role: UserRole | null }) {
  if (!role) return <span className="text-warm-granite">Sem perfil</span>;
  return <Badge variant="outline" title={ROLE_LABEL[role]}>{role}</Badge>;
}

function AccessTable({
  items,
  sort,
  filtered,
  busy,
  pageKey,
  onSort,
}: {
  items: { user_id: string; name: string; role: UserRole | null; active: boolean; units: { id: string; code: string }[] }[];
  sort: UnitAccessSort;
  filtered: boolean;
  busy: boolean;
  pageKey: string;
  onSort: (sort: UnitAccessSort) => void;
}) {
  return (
    <Table busy={busy} aria-label="Vínculos de usuários com unidades">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Usuário" sort={sort} onSortChange={onSort} />
          <TableHead>Perfil</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead>Unidades vinculadas</TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {items.length === 0 ? (
          <TableEmpty
            colSpan={4}
            icon={Link2}
            title={filtered ? "Nenhum vínculo encontrado para os filtros atuais." : "Nenhum vínculo encontrado."}
            description={filtered ? "Ajuste ou limpe os filtros." : "Não há usuários vinculados às unidades do seu escopo."}
          />
        ) : (
          items.map((item, index) => (
            <AnimatedTableRow key={item.user_id} index={index} data-testid="unit-access-row">
              <TableCell className="min-w-[12rem]">
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.name}</span>
              </TableCell>
              <TableCell>
                <RoleBadge role={item.role} />
              </TableCell>
              <TableCell>
                <ActiveBadge active={item.active} feminine={false} />
              </TableCell>
              <TableCell className="min-w-[14rem]">
                {item.units.length === 0 ? (
                  <span className="text-warm-granite">Nenhuma unidade do seu escopo</span>
                ) : (
                  <ul className="flex flex-wrap gap-1.5" aria-label={`Unidades de ${item.name}`}>
                    {item.units.map((unit) => (
                      <li key={unit.id}>
                        <Badge variant="default" className="break-all">
                          {unit.code}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}

export function UnitAccessManageLink() {
  return <ManageLink href="/administracao/usuarios" label="Gerenciar em Usuários" />;
}
