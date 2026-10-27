"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SearchX } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import { FormMessage } from "@/components/ui/form-message";
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
import { ApiError } from "@/lib/api-client";
import { getGoogleSheetsReconciliation, type ImportItemClassification } from "@/lib/imports-api";
import { usePagination } from "@/lib/pagination";

import { CLASSIFICATION_META } from "./classification";
import { reasonLabel } from "./catalog-import-result";

// =============================================================================
// ReconciliationPanel (só ADM) — por que itens da planilha NÃO viram bens:
// `GET /imports/google-sheets/<preview_id>/reconciliation` (total_itens,
// localizados, nao_importados, por_motivo e items). Só contadores e linhas
// (linha, número patrimonial como TEXTO, classificação, motivo); nunca
// descrição/PII. Carregado sob demanda (botão). Mensagens de erro são fixas.
// Os números vêm do backend e não são animados. Paginação 50/100/200 no
// servidor; filtro por motivo recomeça na página 1.
// =============================================================================

const ERROR_FORBIDDEN = "Você não tem permissão para ver a reconciliação desta importação.";
const ERROR_GONE = "Esta prévia expirou ou não foi encontrada. Gere uma nova pré-visualização.";
const ERROR_GENERIC = "Não foi possível carregar a reconciliação. Tente novamente.";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return ERROR_FORBIDDEN;
    if (error.status === 404 || error.status === 409) return ERROR_GONE;
  }
  return ERROR_GENERIC;
}

function Stat({ label, value, id }: { label: string; value: number; id: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="text-body text-bone" data-stat={id}>
        {value}
      </dd>
    </div>
  );
}

function classificationBadge(value: string) {
  const meta = CLASSIFICATION_META[value as ImportItemClassification];
  if (!meta) return <span translate="no">{value}</span>;
  const Icon = meta.icon;
  return (
    <Badge variant={meta.badge} className="whitespace-nowrap">
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

export function ReconciliationPanel({ previewId }: { previewId: string }) {
  const [requested, setRequested] = useState(false);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const pg = usePagination({ persist: false });
  const { page, pageSize, resetPage } = pg;

  const report = useQuery({
    queryKey: ["import-reconciliation", previewId, reason, page, pageSize],
    queryFn: () => getGoogleSheetsReconciliation(previewId, { reason, page, page_size: pageSize }),
    enabled: requested,
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  });

  const data = report.data;
  // Todos os motivos conhecidos vêm do total (sem filtro): o filtro não some ao filtrar.
  const [reasons, setReasons] = useState<[string, number][]>([]);
  if (data && !reason) {
    const next = Object.entries(data.por_motivo).filter(([, count]) => count > 0);
    if (JSON.stringify(next) !== JSON.stringify(reasons)) setReasons(next);
  }

  const listTotal = data ? (data.total ?? (reason ? (data.por_motivo[reason] ?? 0) : data.nao_importados)) : 0;

  function chooseReason(next: string | undefined) {
    setReason(next);
    resetPage();
  }

  return (
    <SlideIn distance="sm">
      <section
        aria-labelledby="reconciliation-title"
        data-testid="reconciliation-panel"
        className="flex flex-col gap-4 rounded-cards border border-carbon-lift p-card-padding"
      >
        <div className="flex flex-col gap-1">
          <h2 id="reconciliation-title" className="text-eyebrow text-pale-stone">
            Reconciliação da importação
          </h2>
          <p className="text-body-sm text-warm-granite">
            Mostra quantos itens da planilha viram bens e o motivo de cada item que não será importado. Só
            administradores.
          </p>
        </div>

        {!requested ? (
          <div>
            <Button variant="outline" size="sm" onClick={() => setRequested(true)}>
              Carregar reconciliação
            </Button>
          </div>
        ) : null}

        {requested && report.isLoading ? (
          <LoadingSkeleton variant="lines" count={3} label="Carregando reconciliação…" />
        ) : null}

        {report.isError ? (
          <div className="flex flex-col gap-2">
            <FormMessage>{errorMessage(report.error)}</FormMessage>
            <Button variant="outline" size="sm" className="self-start" onClick={() => void report.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : null}

        {data ? (
          <>
            <dl className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-3">
              <Stat label="Itens na planilha" value={data.total_itens} id="total_itens" />
              <Stat label="Localizados" value={data.localizados} id="localizados" />
              <Stat label="Não importados" value={data.nao_importados} id="nao_importados" />
            </dl>

            {reasons.length > 0 ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por motivo">
                <FilterPill label="Todos os motivos" active={reason === undefined} onClick={() => chooseReason(undefined)} />
                {reasons.map(([code, count]) => (
                  <FilterPill
                    key={code}
                    label={`${reasonLabel(code)} (${count})`}
                    active={reason === code}
                    onClick={() => chooseReason(code)}
                  />
                ))}
              </div>
            ) : null}

            <Table busy={report.isFetching} aria-label="Itens não importados" regionLabel="Itens não importados (rolável)">
              <TableHeader>
                <TableRow className="hover:bg-transparent focus-within:bg-transparent">
                  <TableHead>Linha</TableHead>
                  <TableHead>Patrimônio</TableHead>
                  <TableHead>Classificação</TableHead>
                  <TableHead>Motivo</TableHead>
                </TableRow>
              </TableHeader>
              <AnimatedTableBody key={`${reason ?? ""}|${page}|${pageSize}`}>
                {data.items.length === 0 ? (
                  <TableEmpty
                    colSpan={4}
                    icon={SearchX}
                    title="Nenhum item não importado."
                    description="Todos os itens localizados podem ser importados."
                  />
                ) : (
                  data.items.map((item, index) => (
                    <AnimatedTableRow key={`${item.row}-${index}`} index={index}>
                      <TableCell className="align-top tabular-nums">{item.row ?? "—"}</TableCell>
                      <TableCell className="align-top">
                        <span translate="no" className="font-mono text-body-sm [overflow-wrap:anywhere]">
                          {item.patrimony_number || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">{classificationBadge(String(item.classification))}</TableCell>
                      <TableCell className="min-w-[9rem] break-words align-top text-body-sm [overflow-wrap:anywhere]">
                        {item.reason_code ? reasonLabel(item.reason_code) : "—"}
                      </TableCell>
                    </AnimatedTableRow>
                  ))
                )}
              </AnimatedTableBody>
            </Table>

            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={listTotal}
              onPageChange={pg.setPage}
              onPageSizeChange={pg.setPageSize}
              busy={report.isFetching}
              noun="item(ns) não importado(s)"
              label="Paginação da reconciliação"
            />
          </>
        ) : null}
      </section>
    </SlideIn>
  );
}
