"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { Database, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { StatusIndicator, type StatusIndicatorState } from "@/components/ui/status-indicator";
import { CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import { UNITS_QUERY_KEY } from "@/components/features/users/unit-checkbox-list";
import {
  CATALOG_CONFIRM_MAX_IDS,
  confirmCatalogImport,
  createCatalogImportPreview,
  getCatalogImportItems,
  type CatalogImportConfirmResponse,
  type CatalogImportKind,
  type CatalogImportPreviewResponse,
} from "@/lib/catalog-imports-api";

import { CatalogImportItemsTable } from "./catalog-import-items-table";
import {
  CATALOG_KIND_LABEL,
  catalogImportErrorMessage,
  isPreviewGone,
  PREVIEW_GONE_MESSAGE,
} from "./catalog-import-labels";
import { CatalogImportReportView } from "./catalog-import-report";
import { CatalogImportResult } from "./catalog-import-result";
import {
  DEFAULT_SELECTION,
  isItemSelected,
  NO_ALIAS_OPT_IN,
  type AliasOptIn,
  type CatalogSelection,
} from "./catalog-import-selection";
import { deriveOutcome, summaryToast, type CatalogOutcome } from "./catalog-import-outcome";
import { PreviewReviewAlert } from "./preview-review-alert";
import { PreviewSummaryCards } from "./preview-summary-cards";

// =============================================================================
// CatalogImportPanel — fluxo de UM cadastro: (1) gerar prévia → (2) revisar
// resumo, relatório e itens → (3) selecionar e confirmar. Toda decisão (perfil,
// AAL2, permissão do tipo, expiração, idempotência) é do backend; aqui só se
// apresenta. O indicador "Requisição" reflete SÓ o estado real das mutations.
// Nenhum número é animado além dos contadores da prévia (valores do backend).
//
// Confirmação: os `item_ids` são coletados ao abrir o diálogo, paginando
// `GET /items` (NOVO e EXISTENTE, 100 por página) e aplicando a seleção local
// (base + exceções) — assim a gravação em massa cobre todas as páginas, não só
// as visitadas, e o diálogo mostra a contagem exata antes de confirmar.
// =============================================================================

const COLLECT_PAGE_SIZE = 100;

interface EligibleItem {
  id: string;
  classification: "NOVO" | "EXISTENTE";
  selected: boolean;
  /** Só unidades: o backend permite criar a sigla de atalho (opt-in do ADM). */
  createAlias: boolean;
}

/** Todos os itens NOVO/EXISTENTE da prévia (≤ 10.000), 100 por requisição. */
async function collectEligible(previewId: string): Promise<EligibleItem[]> {
  const collected: EligibleItem[] = [];
  for (const status of ["NOVO", "EXISTENTE"] as const) {
    let page = 1;
    for (;;) {
      const response = await getCatalogImportItems(previewId, {
        status,
        page,
        page_size: COLLECT_PAGE_SIZE,
        sort: "source_id",
      });
      for (const item of response.items) {
        collected.push({
          id: item.id,
          classification: status,
          selected: item.selected,
          createAlias: item.details?.create_alias === true,
        });
      }
      if (response.items.length === 0 || page * COLLECT_PAGE_SIZE >= response.total) break;
      if (collected.length >= CATALOG_CONFIRM_MAX_IDS) break;
      page += 1;
    }
  }
  return collected;
}

type LastAction = "preview" | "confirm" | null;

export function CatalogImportPanel({ kind }: { kind: CatalogImportKind }) {
  const label = CATALOG_KIND_LABEL[kind];
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<CatalogImportPreviewResponse | null>(null);
  const [selection, setSelection] = useState<CatalogSelection>(DEFAULT_SELECTION);
  // Opt-in explícito de sigla de atalho (só unidades); vazio por padrão, só em memória.
  const [aliasOptIn, setAliasOptIn] = useState<AliasOptIn>(NO_ALIAS_OPT_IN);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<CatalogImportConfirmResponse | null>(null);
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [goneNotice, setGoneNotice] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Relógio de parede para a expiração da prévia (não é refetch de rede).
  useEffect(() => {
    if (!preview) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [preview]);
  const isExpired = preview ? new Date(preview.expires_at).getTime() <= now : false;

  const previewMutation = useMutation({
    mutationFn: () => createCatalogImportPreview(kind),
    onSuccess: (data) => {
      setPreview(data);
      setSelection(DEFAULT_SELECTION);
      setAliasOptIn(NO_ALIAS_OPT_IN);
      setResult(null);
      setGoneNotice(false);
      setNow(Date.now());
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (input: { itemIds: string[]; aliasItemIds: string[] }) =>
      confirmCatalogImport(preview!.preview_id, input.itemIds, input.aliasItemIds),
    onSuccess: (data) => {
      setConfirmOpen(false);
      setResult(data);
      setPreview(null);
      setSelection(DEFAULT_SELECTION);
      setAliasOptIn(NO_ALIAS_OPT_IN);
      queryClient.removeQueries({ queryKey: ["catalog-import-items"] });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      void queryClient.invalidateQueries({ queryKey: UNITS_QUERY_KEY });
      const outcome = deriveOutcome(data);
      const message = summaryToast(data);
      // Verde só quando algo foi salvo SEM rejeições; falha total é erro.
      if (outcome === "success") toast.success(message);
      else if (outcome === "failure") toast.error(message);
      else toast.warning(message);
    },
    onError: (error) => {
      // 404/409: a prévia não vale mais no servidor — exige uma nova.
      if (isPreviewGone(error)) {
        setConfirmOpen(false);
        setPreview(null);
        setSelection(DEFAULT_SELECTION);
        setAliasOptIn(NO_ALIAS_OPT_IN);
        setGoneNotice(true);
        toast.error(catalogImportErrorMessage(error, "confirm"));
      }
    },
  });

  const eligibleQuery = useQuery({
    queryKey: ["catalog-import-eligible", preview?.preview_id],
    queryFn: () => collectEligible(preview!.preview_id),
    enabled: confirmOpen && !!preview,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const handlePreviewGone = useCallback(() => {
    setPreview(null);
    setSelection(DEFAULT_SELECTION);
    setAliasOptIn(NO_ALIAS_OPT_IN);
    setGoneNotice(true);
  }, []);

  const selected = (eligibleQuery.data ?? []).filter((item) => isItemSelected(item, selection));
  const novoCount = selected.filter((item) => item.classification === "NOVO").length;
  const existenteCount = selected.length - novoCount;
  // Sigla só para itens selecionados, que o backend permite (`create_alias`) e que o ADM marcou.
  const aliasItemIds =
    kind === "units" ? selected.filter((item) => item.createAlias && aliasOptIn[item.id]).map((item) => item.id) : [];
  const overLimit = selected.length > CATALOG_CONFIRM_MAX_IDS;

  function handlePreview() {
    setLastAction("preview");
    confirmMutation.reset();
    previewMutation.mutate();
  }

  function openConfirm() {
    confirmMutation.reset();
    setConfirmOpen(true);
  }

  function handleConfirm() {
    setLastAction("confirm");
    confirmMutation.mutate({ itemIds: selected.map((item) => item.id), aliasItemIds });
  }

  const previewError = previewMutation.isError ? catalogImportErrorMessage(previewMutation.error, "preview") : null;
  const dialogError = eligibleQuery.isError
    ? catalogImportErrorMessage(eligibleQuery.error, "items")
    : confirmMutation.isError && !isPreviewGone(confirmMutation.error)
      ? catalogImportErrorMessage(confirmMutation.error, "confirm")
      : overLimit
        ? `A seleção passa de ${CATALOG_CONFIRM_MAX_IDS} itens, o máximo por confirmação. Reduza a seleção.`
        : null;

  const status = requestStatus({
    lastAction,
    previewPending: previewMutation.isPending,
    previewError: previewMutation.isError,
    confirmPending: confirmMutation.isPending,
    confirmError: confirmMutation.isError,
    hasPreview: !!preview,
    isExpired,
    outcome: result ? deriveOutcome(result) : null,
  });

  const eligibleTotal = preview ? preview.summary.novo + preview.summary.existente : 0;
  const canConfirm = !!preview && !isExpired && eligibleTotal > 0;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Button onClick={handlePreview} loading={previewMutation.isPending} disabled={confirmMutation.isPending}>
            {previewMutation.isPending ? "Gerando prévia…" : `Gerar prévia de ${label.plural}`}
          </Button>
          <Button variant="light" disabled={!canConfirm || confirmMutation.isPending} onClick={openConfirm}>
            Confirmar importação
          </Button>
          {preview && isExpired ? (
            <span role="status" className="text-caption text-signal-orange">
              Esta prévia expirou. Gere uma nova prévia para continuar.
            </span>
          ) : null}
        </div>
        <StatusIndicator
          state={status.state}
          label={status.label}
          prefix="Requisição:"
          data-testid="catalog-import-status"
        />
      </div>

      {previewError ? (
        <CatalogNotice onRetry={handlePreview} retrying={previewMutation.isPending}>
          {previewError}
        </CatalogNotice>
      ) : null}
      {goneNotice ? (
        <CatalogNotice>{PREVIEW_GONE_MESSAGE}</CatalogNotice>
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        {previewMutation.isPending ? (
          <SlideIn key="loading" distance="sm" className="flex flex-col gap-6">
            <LoadingSkeleton variant="cards" count={6} label="Lendo a planilha do Google Sheets…" />
            <LoadingSkeleton variant="table" count={5} columns={4} label="Preparando a prévia…" />
          </SlideIn>
        ) : preview ? (
          <SlideIn key={`preview-${preview.preview_id}`} distance="sm" className="flex min-w-0 flex-col gap-8">
            <PreviewSummaryCards summary={preview.summary} />
            <PreviewReviewAlert summary={preview.summary} />
            {kind !== "units" ? (
              <p
                role="status"
                data-testid="catalog-import-alias-dependency"
                className="flex items-start gap-2 text-body-sm text-pale-stone"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
                <span>
                  {label.plural.charAt(0).toUpperCase() + label.plural.slice(1)} dependem da sigla da coluna UNIDADE
                  estar cadastrada como alias de uma unidade.
                  {(preview.report.pendencias?.unidade_sem_alias ?? 0) > 0
                    ? ` ${preview.report.pendencias.unidade_sem_alias} linha(s) estão sem alias e NÃO serão gravadas: importe antes as unidades (criando as siglas) e gere uma nova prévia.`
                    : " Nenhuma linha desta prévia está sem alias."}
                </span>
              </p>
            ) : null}
            <CatalogImportReportView report={preview.report} />
            <CatalogImportItemsTable
              key={preview.preview_id}
              previewId={preview.preview_id}
              kind={kind}
              selection={selection}
              onSelectionChange={setSelection}
              aliasOptIn={aliasOptIn}
              onAliasOptInChange={setAliasOptIn}
              eligibleTotal={eligibleTotal}
              onPreviewGone={handlePreviewGone}
              disabled={confirmMutation.isPending}
            />
          </SlideIn>
        ) : result ? (
          <SlideIn key={`result-${result.sync_job_id}`} distance="sm">
            <CatalogImportResult result={result} />
          </SlideIn>
        ) : !previewError && !goneNotice ? (
          <SlideIn key="idle" distance="sm">
            <EmptyState
              icon={Database}
              title={`Nenhuma prévia de ${label.plural} gerada nesta sessão.`}
              description="Gerar a prévia lê a planilha e classifica cada linha, sem gravar nada. A gravação só acontece após a confirmação expressa de um administrador."
            />
          </SlideIn>
        ) : null}
      </AnimatePresence>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Confirmar importação de ${label.plural}`}
        description={`Esta ação grava em massa no cadastro de ${label.plural} os itens selecionados a partir da planilha do Google Sheets.`}
        consequences={
          eligibleQuery.isPending
            ? ["Contando os itens selecionados…"]
            : [
                `Serão criados: ${novoCount} (Novo). Serão atualizados: ${existenteCount} (Existente).`,
                ...(kind === "units"
                  ? [
                      aliasItemIds.length > 0
                        ? `Siglas de atalho a criar: ${aliasItemIds.length}. A sigla passa a decidir a unidade dos bens importados.`
                        : "Siglas de atalho a criar: 0. Nenhuma sigla será criada (padrão).",
                    ]
                  : []),
                "A gravação é em massa e acontece de uma vez só para toda a seleção.",
                "É idempotente: confirmar de novo a mesma prévia não grava nada (o servidor recusa a segunda confirmação).",
                "Itens duplicados, inválidos ou conflitantes nunca são gravados. Nenhum registro é excluído.",
              ]
        }
        confirmLabel="Confirmar importação"
        pendingLabel="Gravando…"
        pending={confirmMutation.isPending}
        confirmDisabled={eligibleQuery.isPending || eligibleQuery.isError || selected.length === 0 || overLimit}
        error={dialogError}
        onConfirm={handleConfirm}
      />
    </div>
  );
}

interface RequestStatusInput {
  lastAction: LastAction;
  previewPending: boolean;
  previewError: boolean;
  confirmPending: boolean;
  confirmError: boolean;
  hasPreview: boolean;
  isExpired: boolean;
  outcome: CatalogOutcome | null;
}

function requestStatus(input: RequestStatusInput): { state: StatusIndicatorState; label: string } {
  if (input.previewPending) return { state: "loading", label: "Lendo planilha…" };
  if (input.confirmPending) return { state: "loading", label: "Gravando importação…" };
  if (input.lastAction === "confirm") {
    if (input.confirmError) return { state: "error", label: "Falha na confirmação" };
    if (input.outcome === "failure") return { state: "error", label: "Nenhum item salvo" };
    if (input.outcome === "partial") return { state: "warning", label: "Importação parcial" };
    if (input.outcome === "nothing") return { state: "warning", label: "Nada foi salvo" };
    if (input.outcome === "success") return { state: "success", label: "Importação concluída" };
  }
  if (input.lastAction === "preview" && input.previewError) return { state: "error", label: "Falha na leitura" };
  if (input.hasPreview) {
    return input.isExpired
      ? { state: "warning", label: "Prévia expirada" }
      : { state: "success", label: "Prévia pronta" };
  }
  return { state: "idle", label: "Aguardando prévia" };
}
