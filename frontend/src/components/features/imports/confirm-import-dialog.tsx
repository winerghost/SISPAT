"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// =============================================================================
// ConfirmImportDialog
// =============================================================================
// Confirmação expressa antes de `POST /confirm`. Conteúdo segue "Light
// Surface Card" (DialogContent já aplica bg-bone/text-obsidian-canvas). O
// botão "Cancelar" usa `variant="outlineOnLight"` — a variante `outline`
// padrão assume texto claro sobre canvas escuro, ilegível sobre o cartão claro.
// =============================================================================

interface ConfirmImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  novoCount: number;
  existenteCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function ConfirmImportDialog({
  open,
  onOpenChange,
  novoCount,
  existenteCount,
  isSubmitting,
  onConfirm,
}: ConfirmImportDialogProps) {
  const totalAfetado = novoCount + existenteCount;

  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmar importação</DialogTitle>
          <DialogDescription>
            Esta ação grava os itens selecionados no inventário a partir da planilha do Google
            Sheets. Revise as contagens abaixo antes de confirmar.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-eyebrow text-graphite-mid">Serão criados (Novo)</dt>
            <dd className="text-heading text-[28px] text-obsidian-canvas">{novoCount}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-eyebrow text-graphite-mid">Serão atualizados (Existente)</dt>
            <dd className="text-heading text-[28px] text-obsidian-canvas">{existenteCount}</dd>
          </div>
        </dl>

        {totalAfetado === 0 && (
          <p className="text-body-sm text-graphite-mid">
            Nenhum item elegível está selecionado — selecione pelo menos um item Novo ou Existente
            na tabela de prévia antes de confirmar.
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outlineOnLight"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          {/* `loading`: aria-busy + spinner enquanto o POST /confirm não
              responde; o diálogo não fecha (onOpenChange bloqueado) e o
              sucesso só é exibido pelo pai após a resposta do backend. */}
          <Button
            type="button"
            onClick={onConfirm}
            loading={isSubmitting}
            disabled={totalAfetado === 0}
          >
            {isSubmitting ? "Confirmando…" : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
