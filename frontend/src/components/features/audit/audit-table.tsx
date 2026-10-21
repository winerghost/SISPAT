"use client";

import { ArrowDown, ArrowUp, Check, History, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { AuditLogSummary } from "@/lib/audit-api";
import type { AuditSort } from "@/lib/audit-filters";
import { cn } from "@/lib/utils";
import { eventLabel, formatDateTime, RESULT_LABEL, SEVERITY_LABEL, shortId } from "./audit-labels";

// =============================================================================
// AuditTable — lista paginada de `GET /api/v1/admin/audit-logs`.
// Só a data é ordenável (allowlist do backend: `occurred_at`/`-occurred_at`),
// com `aria-sort` e botão nativo. A tabela rola na horizontal DENTRO do próprio
// contêiner — nunca a página. Resultado/severidade = ícone + texto. Todo texto
// vem do backend já projetado e é exibido como texto puro (escape do React).
// =============================================================================

export function ResultBadge({ result }: { result: AuditLogSummary["result"] }) {
  if (!result) return <span className="text-warm-granite">—</span>;
  return (
    <Badge variant={result === "SUCESSO" ? "success" : "warning"}>
      {result === "SUCESSO" ? <Check aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      {RESULT_LABEL[result] ?? result}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: AuditLogSummary["severity"] }) {
  if (!severity) return <span className="text-warm-granite">—</span>;
  const strong = severity === "high" || severity === "critical";
  return (
    <Badge variant={strong ? "warning" : severity === "medium" ? "outline" : "default"}>
      {strong ? <TriangleAlert aria-hidden="true" /> : null}
      {SEVERITY_LABEL[severity] ?? severity}
    </Badge>
  );
}

interface AuditTableProps {
  items: AuditLogSummary[];
  pageKey: string | number;
  busy?: boolean;
  sort: AuditSort;
  onSortChange: (sort: AuditSort) => void;
  onOpen: (item: AuditLogSummary, opener: HTMLElement) => void;
  filtered?: boolean;
}

export function AuditTable({ items, pageKey, busy = false, sort, onSortChange, onOpen, filtered = false }: AuditTableProps) {
  const descending = sort === "-occurred_at";
  const Icon = descending ? ArrowDown : ArrowUp;
  return (
    <Table busy={busy} aria-label="Registros de auditoria">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <TableHead aria-sort={descending ? "descending" : "ascending"}>
            <button
              type="button"
              onClick={() => onSortChange(descending ? "occurred_at" : "-occurred_at")}
              className={cn(
                // `relative`: contém o sr-only dentro do contêiner rolável da tabela.
                "relative -mx-1 inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-buttons px-1 uppercase text-bone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
              )}
            >
              Data e hora
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only">
                {descending ? "(mais recentes primeiro; ativar para inverter)" : "(mais antigos primeiro; ativar para inverter)"}
              </span>
            </button>
          </TableHead>
          <TableHead>Evento</TableHead>
          <TableHead>Entidade</TableHead>
          <TableHead>Resultado</TableHead>
          <TableHead>Severidade</TableHead>
          <TableHead>Autor</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {items.length === 0 ? (
          <TableEmpty
            colSpan={7}
            icon={History}
            title={
              filtered
                ? "Nenhum registro encontrado para os filtros atuais."
                : "Nenhum registro de auditoria no período."
            }
            description={
              filtered
                ? "Ajuste o período ou limpe os filtros."
                : "Sem filtro de data, a consulta cobre os últimos 30 dias."
            }
          />
        ) : (
          items.map((item, index) => {
            const when = formatDateTime(item.occurred_at) ?? item.occurred_at;
            const label = eventLabel(item.event_type);
            return (
              <AnimatedTableRow key={item.id} index={index}>
                <TableCell className="whitespace-nowrap text-warm-granite">
                  <time dateTime={item.occurred_at}>{when}</time>
                </TableCell>
                <TableCell className="min-w-[12rem]">
                  <span className="block break-words [overflow-wrap:anywhere]">{label}</span>
                  {label !== item.event_type ? (
                    <span className="block break-words text-caption text-warm-granite [overflow-wrap:anywhere]">
                      {item.event_type}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-[10rem]">
                  <span className="block break-words [overflow-wrap:anywhere]">{item.entity_type ?? "—"}</span>
                  {item.entity_id ? (
                    <span className="block break-words text-caption text-warm-granite [overflow-wrap:anywhere]">
                      {shortId(item.entity_id)}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <ResultBadge result={item.result} />
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={item.severity} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-warm-granite">
                  {item.actor_user_id ? shortId(item.actor_user_id) : "Sistema"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => onOpen(item, event.currentTarget)}
                    aria-label={`Ver detalhes do registro ${item.event_type}, ${when}`}
                  >
                    Detalhes
                  </Button>
                </TableCell>
              </AnimatedTableRow>
            );
          })
        )}
      </AnimatedTableBody>
    </Table>
  );
}
