"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Sheet } from "@/components/ui/sheet";
import { ApiError, getAuditLog, type AuditLogDetail } from "@/lib/audit-api";
import {
  auditDetailErrorMessage,
  eventLabel,
  fieldLabel,
  formatAuditValue,
  formatDateTimeFull,
} from "./audit-labels";
import { ResultBadge, SeverityBadge } from "./audit-table";

// =============================================================================
// Painel de detalhe do registro (Sheet lateral). Fonte: `GET /admin/audit-logs/<id>`.
// O backend devolve uma PROJEÇÃO segura (allowlist de chaves, valores escalares
// curtos, IP só como rede). Aqui tudo é texto puro: nada de HTML, markdown ou
// JSON.stringify de objetos desconhecidos — o React escapa cada valor. Se o
// backend omitiu campos, só a contagem é mostrada. 404 = inexistente OU fora do
// escopo (o backend não diferencia, de propósito).
// =============================================================================

export const auditDetailQueryKey = (id: string) => ["admin-audit", "detail", id] as const;

export interface AuditDetailSheetProps {
  /** UUID do registro aberto (vem da URL já validada); `undefined` = fechado. */
  id: string | undefined;
  onClose: () => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-carbon-lift py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="min-w-0 break-words text-body-sm text-bone [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-eyebrow text-pale-stone">{title}</h3>
      {children}
    </section>
  );
}

function DetailBody({ log }: { log: AuditLogDetail }) {
  const detailEntries = Object.entries(log.details ?? {});
  const changeEntries = Object.entries(log.changes ?? {});
  const when = formatDateTimeFull(log.occurred_at) ?? log.occurred_at;
  return (
    <div className="flex flex-col gap-6" data-testid="audit-detail">
      <div className="flex flex-wrap items-center gap-2">
        <ResultBadge result={log.result} />
        {log.severity ? <SeverityBadge severity={log.severity} /> : null}
      </div>

      <dl className="flex flex-col">
        <Row label="Data e hora">
          <time dateTime={log.occurred_at}>{when}</time> <span className="text-warm-granite">(Araguaina)</span>
        </Row>
        <Row label="Evento">
          {eventLabel(log.event_type)}
          {eventLabel(log.event_type) !== log.event_type ? (
            <span className="block text-caption text-warm-granite">{log.event_type}</span>
          ) : null}
        </Row>
        <Row label="Entidade">{log.entity_type ?? "—"}</Row>
        <Row label="ID da entidade">{log.entity_id ?? "—"}</Row>
        <Row label="Autor (ID)">{log.actor_user_id ?? "Sistema"}</Row>
        {log.target_type ? <Row label="Alvo">{log.target_type}</Row> : null}
        <Row label="ID da requisição">{log.request_id ?? "—"}</Row>
      </dl>

      {log.request ? (
        <Section title="Requisição">
          <dl className="flex flex-col">
            <Row label="Método">{log.request.method ?? "—"}</Row>
            <Row label="Caminho">{log.request.path ?? "—"}</Row>
            <Row label="Rede de origem">{log.request.network ?? "—"}</Row>
          </dl>
          <p className="text-caption text-warm-granite">O endereço IP completo nunca é exibido; só a rede.</p>
        </Section>
      ) : null}

      {detailEntries.length > 0 ? (
        <Section title="Detalhes">
          <dl className="flex flex-col" data-testid="audit-details">
            {detailEntries.map(([key, value]) => (
              <Row key={key} label={fieldLabel(key)}>
                {formatAuditValue(value)}
              </Row>
            ))}
          </dl>
        </Section>
      ) : null}

      {changeEntries.length > 0 ? (
        <Section title="Alterações">
          <dl className="flex flex-col" data-testid="audit-changes">
            {changeEntries.map(([key, change]) => (
              <Row key={key} label={fieldLabel(key)}>
                {formatAuditValue(change?.from)} <span aria-label="alterado para">→</span> {formatAuditValue(change?.to)}
              </Row>
            ))}
          </dl>
        </Section>
      ) : null}

      {log.omitted_fields > 0 ? (
        <p className="text-caption text-warm-granite" data-testid="audit-omitted">
          {log.omitted_fields} campo(s) não exibido(s) por segurança (texto livre, dados pessoais ou segredos nunca aparecem aqui).
        </p>
      ) : null}
    </div>
  );
}

export function AuditDetailSheet({ id, onClose }: AuditDetailSheetProps) {
  const detail = useQuery({
    queryKey: auditDetailQueryKey(id ?? ""),
    queryFn: () => getAuditLog(id as string),
    enabled: !!id,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

  return (
    <Sheet
      open={!!id}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={detail.data ? eventLabel(detail.data.event_type) : "Registro de auditoria"}
      description={detail.data ? "Somente leitura — a trilha de auditoria não pode ser alterada." : undefined}
    >
      {detail.isPending && detail.fetchStatus !== "idle" ? (
        <LoadingSkeleton variant="lines" count={6} label="Carregando registro…" />
      ) : null}
      {detail.isError ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{auditDetailErrorMessage(detail.error)}</FormMessage>
          <div className="flex gap-2">
            {!(detail.error instanceof ApiError && detail.error.status === 404) ? (
              <Button variant="outline" size="sm" loading={detail.isFetching} onClick={() => detail.refetch()}>
                Tentar novamente
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onClose}>
              Voltar à lista
            </Button>
          </div>
        </div>
      ) : null}
      {detail.data ? <DetailBody log={detail.data} /> : null}
    </Sheet>
  );
}
