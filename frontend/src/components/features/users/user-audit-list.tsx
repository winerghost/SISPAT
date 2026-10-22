"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { usePagination } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { getUserAudit, type UserAuditEvent } from "@/lib/users-api";
import { CHANGE_FIELD_LABEL, formatDateTime, OPERATION_LABEL, userErrorMessage } from "./user-labels";

// =============================================================================
// Histórico — `GET /api/v1/users/<id>/audit` (paginado). Inclui eventos em que
// a pessoa é alvo ou autora. `changes` (allowlist do backend: role, units,
// active, avatar, sessions_revoked_at) é exibido SEMPRE como texto escapado
// pelo React — nunca HTML. Datas em America/Araguaina.
// =============================================================================

export const userAuditQueryKey = (userId: string) => ["users", "audit", userId] as const;

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "string") {
    if (field.endsWith("_at")) return formatDateTime(value) ?? value;
    return value;
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "nenhuma";
    return value.map((item) => formatValue(field, item)).join(", ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.name === "string") return `${record.code} — ${record.name}`;
    if (typeof record.name === "string") return record.name;
    if (typeof record.code === "string") return record.code;
    return JSON.stringify(value);
  }
  return String(value);
}

/** Uma linha de texto por campo alterado: "Perfil: USER → ADM". */
export function describeChanges(changes: UserAuditEvent["changes"]): string[] {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([field, change]) => {
    const label = CHANGE_FIELD_LABEL[field] ?? field;
    if (change && typeof change === "object" && !Array.isArray(change) && ("from" in change || "to" in change)) {
      const { from, to } = change as { from?: unknown; to?: unknown };
      return `${label}: ${formatValue(field, from)} → ${formatValue(field, to)}`;
    }
    return `${label}: ${formatValue(field, change)}`;
  });
}

export function UserAuditList({ userId }: { userId: string }) {
  // Histórico no painel lateral: tamanho próprio (não herda o das listas).
  const pg = usePagination({ persist: false });
  const { page, pageSize } = pg;
  const audit = useQuery({
    queryKey: [...userAuditQueryKey(userId), page, pageSize],
    queryFn: () => getUserAudit(userId, { page, page_size: pageSize }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  if (audit.isPending) return <LoadingSkeleton variant="lines" count={4} label="Carregando histórico…" />;

  if (audit.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormMessage>{userErrorMessage(audit.error, "Não foi possível carregar o histórico. Tente novamente.")}</FormMessage>
        <Button variant="outline" size="sm" loading={audit.isFetching} onClick={() => audit.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const { events, total } = audit.data;

  if (events.length === 0) {
    return <EmptyState icon={History} title="Nenhum evento registrado para este usuário." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <StaggerContainer
        as="ol"
        key={`${page}-${pageSize}`}
        aria-label="Histórico de alterações"
        aria-busy={audit.isPlaceholderData || undefined}
        className={cn("flex flex-col gap-3 transition-opacity duration-base ease-factory", audit.isPlaceholderData && "opacity-60")}
      >
        {events.map((event, index) => {
          const lines = describeChanges(event.changes);
          const success = /^(sucesso|success)$/i.test(event.result);
          return (
            <StaggerItem as="li" key={event.id} index={index} className="flex flex-col gap-1.5 rounded-cards border border-ash-stroke p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-bone">{OPERATION_LABEL[event.operation] ?? event.operation}</span>
                <Badge variant={success ? "success" : "warning"}>{event.result}</Badge>
              </div>
              <p className="text-caption leading-[1.4] text-warm-granite">
                <time dateTime={event.occurred_at}>{formatDateTime(event.occurred_at) ?? event.occurred_at}</time>
                {" · "}
                {event.actor ? `por ${event.actor.name}` : "pelo sistema"}
              </p>
              {lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-body-sm text-pale-stone">
                  {lines.map((line, i) => (
                    <li key={i} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </StaggerItem>
          );
        })}
      </StaggerContainer>

      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={pg.setPage}
        onPageSizeChange={pg.setPageSize}
        busy={audit.isFetching}
        noun="evento(s)"
        label="Paginação do histórico"
      />
    </div>
  );
}
