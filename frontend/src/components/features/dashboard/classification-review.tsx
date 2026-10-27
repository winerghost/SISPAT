"use client";

import { useId, useState } from "react";
import { AlertTriangle, BarChart3, Download, RefreshCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import { useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { ApiError } from "@/lib/api-client";
import {
  REVIEW_QUEUE_PREFIX,
  REVIEW_SORT_VALUES,
  downloadReviewExport,
  exportErrorMessage,
  overrideCategory,
  overrideErrorKind,
  useReviewQueue,
  type ExportFormat,
  type ReviewCategory,
  type ReviewItem,
  type ReviewSort,
} from "@/lib/dashboard-equipment-api";
import { usePagination } from "@/lib/pagination";
import { cn } from "@/lib/utils";

import { confidenceLabel } from "./equipment-format";

// =============================================================================
// Fila de revisão de classificação (só ADM + AAL2: o backend decide; um 403/404
// vira mensagem neutra). Lista os bens "Outros" com confiança baixa e deixa o
// ADM corrigir a categoria. A lista de categorias vem da PRÓPRIA resposta
// (`categorias`). Fluxo seguro:
//  - escolher a categoria só prepara a correção; nada é gravado até confirmar;
//  - confirmar envia `{category, version}`; o item só sai da fila DEPOIS da
//    resposta 200 (recarrega a fila do servidor; nunca se atualiza otimista);
//  - 409 (outra pessoa alterou o bem): fecha, recarrega a fila e avisa;
//  - 400/403/404/outros: mensagem fixa, sem detalhe do backend.
// Tabela vira cartões abaixo de `lg`; nenhuma rolagem horizontal da página.
// =============================================================================

const SORT_LABEL: Record<ReviewSort, string> = {
  patrimony_number: "Nº patrimonial (crescente)",
  "-patrimony_number": "Nº patrimonial (decrescente)",
  description: "Descrição (A–Z)",
  "-description": "Descrição (Z–A)",
  updated_at: "Atualização (mais antigos)",
  "-updated_at": "Atualização (mais recentes)",
};
const isSort = (v: string): v is ReviewSort => (REVIEW_SORT_VALUES as readonly string[]).includes(v);

const CONFLICT_MESSAGE = "Este bem foi alterado por outra pessoa. A fila foi recarregada; revise e tente de novo.";
const DENIED_MESSAGE = "Não foi possível aplicar a correção: o bem não está disponível ou seu perfil não permite esta ação.";
const OTHER_MESSAGE = "Não foi possível aplicar a correção. Tente novamente.";

interface Pending {
  item: ReviewItem;
  category: ReviewCategory;
}

function CategorySelect({
  item,
  categories,
  disabled,
  onPick,
}: {
  item: ReviewItem;
  categories: ReviewCategory[];
  disabled: boolean;
  onPick: (category: ReviewCategory) => void;
}) {
  const id = `rv-${useId().replace(/:/g, "")}`;
  const groups = Array.from(new Set(categories.map((c) => c.familia_label)));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {`Nova categoria do bem ${item.patrimony_number}`}
      </label>
      <select
        id={id}
        value=""
        disabled={disabled}
        data-review-select={item.id}
        onChange={(event) => {
          const picked = categories.find((c) => c.id === event.target.value);
          if (picked) onPick(picked);
        }}
        className={cn(selectControlClassName, "min-w-0")}
      >
        <option value="">Corrigir para…</option>
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {categories
              .filter((c) => c.familia_label === group)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function ClassificationReview() {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const queryClient = useQueryClient();
  const pagination = usePagination({ storageKey: "sispat-page-size-review" });
  const [unitId, setUnitId] = useState("");
  const [sort, setSort] = useState<ReviewSort>("patrimony_number");
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [exportBusy, setExportBusy] = useState<ExportFormat | null>(null);
  const unitSelectId = `rv-unit-${useId().replace(/:/g, "")}`;
  const sortSelectId = `rv-sort-${useId().replace(/:/g, "")}`;

  const params = { page: pagination.page, pageSize: pagination.pageSize, unitId: unitId || undefined, sort };
  const query = useReviewQueue(params, access.ready);

  const mutation = useMutation({
    mutationFn: ({ item, category }: Pending) => overrideCategory(item.id, category.id, item.version),
  });

  const reload = () => queryClient.invalidateQueries({ queryKey: REVIEW_QUEUE_PREFIX });

  async function confirm() {
    if (!pending) return;
    const { item, category } = pending;
    setDialogError(null);
    try {
      await mutation.mutateAsync(pending);
    } catch (error) {
      const kind = overrideErrorKind(error);
      if (kind === "conflict") {
        setPending(null);
        setNotice({ kind: "error", text: CONFLICT_MESSAGE });
        await reload();
      } else {
        setDialogError(kind === "denied" ? DENIED_MESSAGE : OTHER_MESSAGE);
      }
      return;
    }
    // Só depois do 200: a fila é recarregada do servidor (nunca otimista).
    setPending(null);
    setNotice({ kind: "ok", text: `Bem ${item.patrimony_number} corrigido para “${category.label}”.` });
    await reload();
    // Painéis e indicador de pendentes também mudaram no servidor.
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "panel-data"] });
  }

  async function runExport(format: ExportFormat) {
    setExportBusy(format);
    setNotice(null);
    try {
      const name = await downloadReviewExport(format, { unitId: unitId || undefined, sort });
      setNotice({ kind: "ok", text: `Arquivo ${name} gerado.` });
    } catch (error) {
      setNotice({ kind: "error", text: exportErrorMessage(error) });
    } finally {
      setExportBusy(null);
    }
  }

  const data = query.data;
  const forbidden = query.isError && query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 404);
  const busy = query.isFetching;

  return (
    <section aria-labelledby="rv-title" data-review-queue className="flex min-w-0 flex-col gap-4">
      <h2 id="rv-title" className="sr-only">
        Fila de revisão de classificação
      </h2>

      <form
        aria-label="Filtros da fila de revisão"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={unitSelectId} className="text-eyebrow text-pale-stone">
            Unidade
          </label>
          <select
            id={unitSelectId}
            value={unitId}
            disabled={units.isError}
            onChange={(event) => {
              setUnitId(event.target.value);
              pagination.resetPage();
            }}
            className={cn(selectControlClassName, "min-w-0")}
          >
            <option value="">Todas as unidades visíveis</option>
            {units.data?.units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unitLabel(unit)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={sortSelectId} className="text-eyebrow text-pale-stone">
            Ordenar por
          </label>
          <select
            id={sortSelectId}
            value={sort}
            onChange={(event) => {
              if (isSort(event.target.value)) {
                setSort(event.target.value);
                pagination.resetPage();
              }
            }}
            className={cn(selectControlClassName, "min-w-0")}
          >
            {REVIEW_SORT_VALUES.map((value) => (
              <option key={value} value={value}>
                {SORT_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2" data-review-export>
        {(["csv", "xlsx"] as const).map((format) => (
          <Button
            key={format}
            type="button"
            variant="ghost"
            size="sm"
            loading={exportBusy === format}
            disabled={exportBusy !== null || !data || data.total === 0}
            onClick={() => void runExport(format)}
          >
            <Download aria-hidden />
            {`Exportar fila ${format.toUpperCase()}`}
          </Button>
        ))}
      </div>

      <div aria-live="polite" className="min-h-[1lh]" data-review-notice>
        {notice ? (
          <SlideIn distance="sm" key={notice.text}>
            <p role={notice.kind === "error" ? "alert" : "status"} className="text-body-sm text-bone">
              {notice.text}
            </p>
          </SlideIn>
        ) : null}
      </div>

      {query.isPending ? (
        <LoadingSkeleton variant="table" count={5} columns={4} label="Carregando fila de revisão" />
      ) : query.isError && !data ? (
        <div role="alert" data-review-error className="flex flex-col items-start gap-3">
          <p className="flex items-start gap-2 text-body-sm text-bone">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            {forbidden
              ? "A fila de revisão não está disponível para o seu perfil."
              : "Não foi possível carregar a fila de revisão. Nenhum valor foi estimado."}
          </p>
          {forbidden ? null : (
            <Button variant="ghost" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden="true" />
              Tentar novamente
            </Button>
          )}
        </div>
      ) : data && data.total === 0 ? (
        <div data-review-empty className="flex flex-col items-start gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-buttons border border-carbon-lift text-warm-granite">
            <BarChart3 className="h-4 w-4" aria-hidden="true" />
          </span>
          <p className="text-body text-bone">Nenhum bem aguardando revisão</p>
          <p className="max-w-xl text-body-sm text-warm-granite">
            {unitId
              ? "Não há pendências nesta unidade. Escolha outra unidade ou veja todas."
              : "Todos os bens “Outros” de confiança baixa já foram revisados."}
          </p>
        </div>
      ) : data ? (
        <div className="flex min-w-0 flex-col gap-4" aria-busy={busy || undefined}>
          <div className="hidden lg:block" data-review-table>
            <div className="w-full overflow-x-auto" role="region" aria-label="Bens pendentes de revisão (rolável)" tabIndex={0}>
              <table className="w-full text-left text-body-sm">
                <caption className="sr-only">Bens pendentes de revisão de classificação</caption>
                <thead>
                  <tr className="border-b border-ash-stroke">
                    {["Nº patrimonial", "Descrição", "Unidade", "Confiança", "Corrigir categoria"].map((h) => (
                      <th key={h} scope="col" className="px-4 py-2 text-eyebrow font-regular text-pale-stone">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id} className="border-b border-carbon-lift align-middle" data-review-row={item.id}>
                      <th scope="row" className="px-4 py-2 font-regular text-bone">
                        {item.patrimony_number}
                      </th>
                      <td className="max-w-md break-words px-4 py-2 text-bone">{item.description ?? "—"}</td>
                      <td className="px-4 py-2 text-bone">{item.unidade}</td>
                      <td className="px-4 py-2 text-warm-granite">{confidenceLabel(item.classification_confidence)}</td>
                      <td className="min-w-[14rem] px-4 py-2">
                        <CategorySelect
                          item={item}
                          categories={data.categorias}
                          disabled={mutation.isPending}
                          onPick={(category) => {
                            setDialogError(null);
                            setPending({ item, category });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <ul aria-label="Bens pendentes de revisão" className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:hidden" data-review-cards>
            {data.items.map((item) => (
              <li key={item.id} className="flex min-w-0 flex-col gap-2 rounded-cards border border-carbon-lift p-3" data-review-row={item.id}>
                <p className="text-body-sm text-bone">
                  <span className="text-caption text-warm-granite">Nº patrimonial </span>
                  {item.patrimony_number}
                </p>
                <p className="break-words text-body-sm text-bone">{item.description ?? "—"}</p>
                <p className="text-caption text-warm-granite">
                  {item.unidade} · Confiança {confidenceLabel(item.classification_confidence).toLowerCase()}
                </p>
                <CategorySelect
                  item={item}
                  categories={data.categorias}
                  disabled={mutation.isPending}
                  onPick={(category) => {
                    setDialogError(null);
                    setPending({ item, category });
                  }}
                />
              </li>
            ))}
          </ul>

          <PaginationBar
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={data.total}
            busy={busy}
            noun="bem(ns) pendente(s)"
            label="Paginação da fila de revisão"
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />
        </div>
      ) : null}

      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setDialogError(null);
          }
        }}
        title="Confirmar correção de categoria"
        description={
          pending
            ? `Bem ${pending.item.patrimony_number}${pending.item.description ? ` — ${pending.item.description}` : ""}.`
            : ""
        }
        consequences={
          pending
            ? [
                `A categoria passará a ser “${pending.category.label}” (${pending.category.familia_label}).`,
                "A correção manual prevalece sobre a regra automática e fica registrada na auditoria.",
                "O bem sai da fila de revisão assim que o servidor confirmar.",
              ]
            : undefined
        }
        confirmLabel="Confirmar correção"
        pendingLabel="Aplicando…"
        pending={mutation.isPending}
        error={dialogError}
        onConfirm={() => void confirm()}
      />
    </section>
  );
}
