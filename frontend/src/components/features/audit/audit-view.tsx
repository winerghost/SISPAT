"use client";

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { AccessRestrictedPanel, SESSION_UNCONFIRMED_MESSAGE } from "@/components/features/modules/access-restricted";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ApiError, isAuditDenied, listAuditLogs } from "@/lib/audit-api";
import {
  AUDIT_PAGE_SIZE,
  auditUrlQuery,
  hasAuditFilters,
  parseAuditUrl,
  type AuditFilters,
  type AuditSort,
} from "@/lib/audit-filters";
import { useMe } from "@/lib/session";
import { AuditDetailSheet } from "./audit-detail-sheet";
import { AuditFiltersForm } from "./audit-filters-form";
import { AUDIT_DENIED_MESSAGE, auditListErrorMessage } from "./audit-labels";
import { AuditTable } from "./audit-table";

// =============================================================================
// /administracao/auditoria — consulta SOMENTE LEITURA da trilha (ADM + AAL2 +
// audit.read). Filtros, ordenação, página e registro aberto vivem na URL (link
// compartilhável) com parse defensivo por allowlist (`audit-filters.ts`).
// Dados só são pedidos depois que `/me` confirma ADM; quem autoriza de fato é o
// backend (401/403 viram "acesso restrito" com texto fixo).
// =============================================================================

const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

export function AuditView() {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.toString();
  const state = useMemo(() => parseAuditUrl(new URLSearchParams(raw)), [raw]);
  // Chave da LISTA (sem `id`): abrir/fechar o painel não pode remontar tabela nem formulário
  // (perderia o foco devolvido ao botão e o rascunho dos filtros).
  const canonical = auditUrlQuery({ filters: state.filters, page: state.page });
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  /** Botão que abriu o painel: recebe o foco de volta ao fechar (WCAG 2.4.3). */
  const openerRef = useRef<HTMLElement | null>(null);

  const go = useCallback(
    (next: { filters: AuditFilters; page: number; id?: string }, mode: "push" | "replace" = "push") => {
      const query = auditUrlQuery(next);
      const href = query ? `${pathname}?${query}` : pathname;
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router],
  );

  const closeDetail = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    go({ filters: state.filters, page: state.page }, "replace");
    if (opener) {
      // O Radix só solta o foco depois da animação de saída do painel: espera o
      // diálogo sair do DOM (até ~1 s) e devolve o foco ao botão que o abriu.
      let attempts = 0;
      const restore = () => {
        attempts += 1;
        const dialogOpen = !!document.querySelector("[role=dialog]");
        if (dialogOpen && attempts < 20) {
          setTimeout(restore, 50);
          return;
        }
        if (opener.isConnected && (!document.activeElement || document.activeElement === document.body)) {
          opener.focus();
        }
      };
      setTimeout(restore, 50);
    }
  }, [go, state.filters, state.page]);

  const listQuery = useQuery({
    queryKey: ["admin-audit", "list", state.filters, state.page],
    queryFn: () => listAuditLogs(state.filters, state.page),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
    retry,
  });

  const filtered = hasAuditFilters(state.filters);
  const busy = listQuery.isFetching && !listQuery.isPending;
  const changing = listQuery.isPlaceholderData;

  let body: ReactNode;
  if (me.isPending) {
    body = <LoadingSkeleton variant="lines" count={3} label="Verificando permissões…" />;
  } else if (me.isError) {
    body = <AccessRestrictedPanel message={SESSION_UNCONFIRMED_MESSAGE} />;
  } else if (!isAdmin) {
    body = <AccessRestrictedPanel />;
  } else if (isAuditDenied(listQuery.error)) {
    body = <AccessRestrictedPanel message={AUDIT_DENIED_MESSAGE} />;
  } else {
    body = (
      <>
        <section aria-label="Filtros" className="flex flex-col gap-4">
          <AuditFiltersForm
            key={canonical}
            applied={state.filters}
            hasFilters={filtered}
            onApply={(next) => go({ filters: { ...next, sort: state.filters.sort }, page: 1 })}
            onClear={() => go({ filters: { sort: state.filters.sort }, page: 1 })}
          />
        </section>

        {listQuery.isPending ? (
          <LoadingSkeleton variant="table" count={6} columns={6} label="Carregando registros de auditoria…" />
        ) : null}

        {listQuery.isError ? (
          <CatalogNotice onRetry={() => void listQuery.refetch()} retrying={listQuery.isFetching}>
            {auditListErrorMessage(listQuery.error)}
          </CatalogNotice>
        ) : null}

        {listQuery.data ? (
          <>
            <AuditTable
              items={listQuery.data.items}
              pageKey={`${listQuery.data.page}|${canonical}`}
              busy={busy}
              sort={state.filters.sort}
              filtered={filtered}
              onSortChange={(sort: AuditSort) => go({ filters: { ...state.filters, sort }, page: 1 })}
              onOpen={(item, opener) => {
                openerRef.current = opener;
                go({ filters: state.filters, page: state.page, id: item.id });
              }}
            />
            <CatalogPagination
              page={listQuery.data.page}
              total={listQuery.data.total}
              pageSize={listQuery.data.page_size || AUDIT_PAGE_SIZE}
              noun="registro(s)"
              loading={changing}
              onPage={(page) => go({ filters: state.filters, page })}
            />
          </>
        ) : null}

        <AuditDetailSheet id={state.id} onClose={closeDetail} />
      </>
    );
  }

  return <>{body}</>;
}
