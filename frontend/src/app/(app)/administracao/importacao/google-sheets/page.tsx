"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { StatusIndicator, type StatusIndicatorState } from "@/components/ui/status-indicator";
import { PreviewSummaryCards } from "@/components/features/imports/preview-summary-cards";
import { PreviewReviewAlert } from "@/components/features/imports/preview-review-alert";
import { PreviewItemsTable, type SelectionSummary } from "@/components/features/imports/preview-items-table";
import { ConfirmImportDialog } from "@/components/features/imports/confirm-import-dialog";
import { PendingCountsPanel } from "@/components/features/imports/pending-counts-panel";
import { CatalogImportResult } from "@/components/features/imports/catalog-import-result";
import {
  assetResultView,
  deriveOutcome,
  summaryToast,
  type CatalogOutcome,
} from "@/components/features/imports/catalog-import-outcome";
import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import {
  confirmGoogleSheetsImport,
  createGoogleSheetsPreview,
  type ImportConfirmResponse,
  type ImportPreviewResponse,
} from "@/lib/imports-api";

// =============================================================================
// Administração → Importação de Dados → Google Sheets
// =============================================================================
// Fluxo: (1) gerar prévia → (2) revisar/filtrar/selecionar itens na tabela
// paginada → (3) confirmar importação dos itens elegíveis selecionados.
//
// Autenticação: todos os endpoints exigem usuário ADM com permissão
// `imports.execute` (+ AAL2). O `apiClient` anexa `Authorization` da sessão
// Supabase automaticamente; 401 = sessão ausente/expirada e 403 = sem
// permissão — ambos tratados abaixo com mensagens genéricas (a mensagem do
// backend nunca é exibida).
//
// Motion / feedback (ver docs/ux/evidence/telas-dados.md):
// - O indicador "Requisição" reflete SOMENTE o estado real das mutations
//   (idle → lendo → prévia pronta/expirada/erro; confirmando → concluída/
//   erro). Não há barra de percentual: o backend não devolve progresso.
// - A área principal troca entre vazio / skeleton / prévia / resultado com
//   fade + 4px (AnimatePresence mode="wait": a saída de 150 ms termina antes
//   da entrada). Sucesso (toast + resumo) só no onSuccess da confirmação.
// =============================================================================

const EMPTY_SELECTION: SelectionSummary = { selectedIds: [], novoCount: 0, existenteCount: 0 };

type LastAction = "preview" | "confirm" | null;

export default function ImportacaoGoogleSheetsPage() {
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [selection, setSelection] = useState<SelectionSummary>(EMPTY_SELECTION);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ImportConfirmResponse | null>(null);
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [now, setNow] = useState(() => Date.now());

  // Mantém a verificação de expiração da prévia atualizada mesmo sem
  // interação do usuário (relógio de parede, não um refetch de rede).
  useEffect(() => {
    if (!preview) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [preview]);

  const isExpired = preview ? new Date(preview.expires_at).getTime() <= now : false;

  const previewMutation = useMutation({
    mutationFn: createGoogleSheetsPreview,
    onSuccess: (data) => {
      setPreview(data);
      setSelection(EMPTY_SELECTION);
      setLastResult(null);
      setNow(Date.now());
    },
  });

  const confirmMutation = useMutation({
    mutationFn: confirmGoogleSheetsImport,
    onSuccess: (data) => {
      setConfirmOpen(false);
      setLastResult(data);
      // Invalida a prévia local — não permite reconfirmar a mesma prévia;
      // o usuário precisa gerar uma nova para uma próxima importação.
      setPreview(null);
      setSelection(EMPTY_SELECTION);
      // Verde só quando algo foi salvo SEM rejeições (status do job do backend
      // tem precedência); falha total é erro; parcial/nada salvo é aviso.
      const view = assetResultView(data);
      const outcome = deriveOutcome(view);
      const message = summaryToast(view);
      if (outcome === "success") toast.success(message);
      else if (outcome === "failure") toast.error(message);
      else toast.warning(message);
    },
    onError: (error) => {
      setConfirmOpen(false);
      toast.error(confirmErrorMessage(error));
      // 404/409 significam que a prévia não é mais válida no servidor —
      // força uma nova pré-visualização em vez de deixar o usuário tentar
      // confirmar novamente algo que o backend já rejeitou.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        setPreview(null);
        setSelection(EMPTY_SELECTION);
      }
    },
  });

  const handleSelectionChange = useCallback((summary: SelectionSummary) => {
    setSelection(summary);
  }, []);

  const canConfirm = !!preview && !isExpired && selection.selectedIds.length > 0;

  function handlePreview() {
    // Sem duplo disparo: ignora cliques enquanto há leitura em andamento.
    if (previewMutation.isPending || confirmMutation.isPending) return;
    setLastAction("preview");
    previewMutation.mutate();
  }

  function handleConfirm() {
    if (!preview) return;
    setLastAction("confirm");
    confirmMutation.mutate({ preview_id: preview.preview_id, selected_item_ids: selection.selectedIds });
  }

  const previewError = previewMutation.isError ? previewErrorMessage(previewMutation.error) : null;

  const status = requestStatus({
    lastAction,
    previewPending: previewMutation.isPending,
    previewError: previewMutation.isError,
    confirmPending: confirmMutation.isPending,
    confirmError: confirmMutation.isError,
    hasPreview: !!preview,
    isExpired,
    outcome: lastResult ? deriveOutcome(assetResultView(lastResult)) : null,
  });

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Administração / Importação de Dados</span>
        <h1 className="text-heading text-bone">Google Sheets</h1>
        <p className="text-body-sm text-warm-granite">
          Pré-visualize os registros da planilha de origem e revise cada item antes de confirmar a
          importação para o inventário.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Button
            onClick={handlePreview}
            loading={previewMutation.isPending}
            disabled={confirmMutation.isPending}
          >
            {previewMutation.isPending ? "Gerando pré-visualização…" : "Pré-visualizar Importação"}
          </Button>

          <Button
            variant="light"
            disabled={!canConfirm || confirmMutation.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            Confirmar Importação
          </Button>

          {preview && isExpired && (
            <span role="status" className="text-caption text-signal-orange">
              Esta prévia expirou. Gere uma nova pré-visualização para continuar.
            </span>
          )}
        </div>

        <StatusIndicator
          state={status.state}
          label={status.label}
          prefix="Requisição:"
          data-testid="import-request-status"
        />
      </div>

      {previewError && (
        <SlideIn distance="sm">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>{previewError}</FormMessage>
            <Button variant="outline" size="sm" className="self-start" onClick={handlePreview} disabled={previewMutation.isPending}>
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {previewMutation.isPending ? (
          <SlideIn key="loading" distance="sm" className="flex flex-col gap-6">
            <LoadingSkeleton variant="cards" count={6} label="Lendo a planilha do Google Sheets…" />
            <LoadingSkeleton variant="table" count={5} columns={4} label="Preparando a tabela de itens…" />
          </SlideIn>
        ) : preview ? (
          <SlideIn key={`preview-${preview.preview_id}`} distance="sm" className="flex flex-col gap-8">
            <PreviewSummaryCards summary={preview.summary} />
            <PreviewReviewAlert summary={preview.summary} />
            {preview.pending_counts ? (
              <PendingCountsPanel previewId={preview.preview_id} counts={preview.pending_counts} />
            ) : null}
            <PreviewItemsTable
              key={preview.preview_id}
              previewId={preview.preview_id}
              onSelectionSummaryChange={handleSelectionChange}
            />
          </SlideIn>
        ) : lastResult ? (
          <SlideIn key={`result-${lastResult.sync_job_id}`} distance="sm">
            <CatalogImportResult result={assetResultView(lastResult)} />
          </SlideIn>
        ) : !previewError ? (
          <SlideIn key="idle" distance="sm">
            <EmptyState
              icon={FileSpreadsheet}
              title="Nenhuma prévia gerada nesta sessão."
              description="A leitura da planilha não altera patrimônios. Nada é gravado sem a confirmação expressa de um administrador."
            />
          </SlideIn>
        ) : null}
      </AnimatePresence>

      <ConfirmImportDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        novoCount={selection.novoCount}
        existenteCount={selection.existenteCount}
        isSubmitting={confirmMutation.isPending}
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

/** Estado exibido no indicador — derivado só do estado real das mutations. */
function requestStatus(input: RequestStatusInput): { state: StatusIndicatorState; label: string } {
  if (input.previewPending) return { state: "loading", label: "Lendo planilha…" };
  if (input.confirmPending) return { state: "loading", label: "Confirmando importação…" };
  if (input.lastAction === "confirm") {
    if (input.confirmError) return { state: "error", label: "Falha na confirmação" };
    if (input.outcome === "failure") return { state: "error", label: "Nenhum item salvo" };
    if (input.outcome === "partial") return { state: "warning", label: "Importação parcial" };
    if (input.outcome === "nothing") return { state: "warning", label: "Nada foi salvo" };
    if (input.outcome === "success") return { state: "success", label: "Importação concluída" };
  }
  if (input.lastAction === "preview" && input.previewError) {
    return { state: "error", label: "Falha na leitura" };
  }
  if (input.hasPreview) {
    return input.isExpired
      ? { state: "warning", label: "Prévia expirada" }
      : { state: "success", label: "Prévia pronta" };
  }
  return { state: "idle", label: "Aguardando pré-visualização" };
}

function previewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Sessão não autenticada. Faça login novamente para gerar uma pré-visualização.";
    }
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 403) {
      return "Você não tem permissão para executar importações. Solicite ao administrador o papel ADM com a permissão de execução de importações.";
    }
    if (error.status === 0) {
      return "Sem resposta do servidor. Verifique sua conexão ou aguarde um instante e tente novamente; planilhas grandes podem demorar mais.";
    }
    if (error.status === 502) {
      return "Não foi possível ler a planilha do Google Sheets agora. Tente novamente em alguns instantes.";
    }
    if (error.status === 503 || error.status === 504) {
      return "A leitura demorou mais que o esperado ou o serviço está indisponível; aguarde um instante e tente novamente.";
    }
    if (error.status >= 500) {
      return "O servidor não conseguiu concluir a leitura da planilha. Aguarde um instante e tente novamente; se persistir, contate o suporte.";
    }
  }
  return "Não foi possível gerar a pré-visualização. Tente novamente.";
}

function confirmErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Sessão não autenticada. Faça login novamente.";
    }
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 403) {
      return "Você não tem permissão para confirmar importações.";
    }
    if (error.status === 404) {
      return "Esta prévia não foi encontrada. Gere uma nova pré-visualização.";
    }
    if (error.status === 409) {
      return "Esta prévia expirou. Gere uma nova pré-visualização.";
    }
    if (error.status === 502) {
      return "Falha ao comunicar com o Google Sheets durante a confirmação. Tente novamente.";
    }
  }
  return "Não foi possível confirmar a importação. Tente novamente.";
}
