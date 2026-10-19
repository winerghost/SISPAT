"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, textareaControlClassName } from "@/components/ui/form-field";
import { transitionInventory, type InventoryAction, type InventoryRecord } from "@/lib/inventories-api";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import {
  blankToUndefined,
  inventoriesQueryKey,
  inventoryErrorMessage,
  isInventoryNotFound,
  isStaleConflict,
  REASON_MAX,
  TRANSITION_COPY,
} from "./inventory-labels";

// =============================================================================
// Iniciar / encerrar / cancelar inventário (só ADM + AAL2; o backend decide).
// Cada ação é uma transição ÚNICA e irreversível: CONCLUÍDO e CANCELADO são
// terminais e IMUTÁVEIS. O diálogo explica o efeito ANTES de chamar o backend; o
// motivo (opcional, ≤500) vai só para a auditoria. O sucesso só é exibido depois
// da resposta. 409 `invalid_transition` (estado mudou) fecha, avisa e recarrega.
// =============================================================================

export function InventoryTransitionDialog({
  open,
  onOpenChange,
  inventory,
  action,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventory: InventoryRecord;
  action: InventoryAction;
  /** `saved` = registro devolvido pelo backend; `null` = o estado mudou (recarregar). */
  onDone: (saved: InventoryRecord | null) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const copy = TRANSITION_COPY[action];

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => {
      const text = blankToUndefined(reason);
      return transitionInventory(inventory.id, action, text ? { reason: text } : {});
    },
    onSuccess: (saved) => {
      toast.success(copy.success);
      void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
      onOpenChange(false);
      onDone(saved);
    },
    onError: (err) => {
      if (isStaleConflict(err) || isInventoryNotFound(err)) {
        toast.error(inventoryErrorMessage(err, copy.failure));
        void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
        onOpenChange(false);
        onDone(null);
        return;
      }
      setError(inventoryErrorMessage(err, copy.failure));
    },
  });

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={<>Inventário: {inventory.name}.</>}
      consequences={copy.consequences}
      confirmLabel={copy.confirm}
      pendingLabel={copy.pending}
      pending={mutation.isPending}
      error={error}
      onConfirm={() => {
        setError(null);
        mutation.mutate();
      }}
    >
      <FormField id="inv-acao-motivo" label="Motivo (opcional)" surface="light" hint="Até 500 caracteres. Só um indicador de que há motivo vai à auditoria.">
        {(field) => (
          <textarea
            {...field}
            name="reason"
            maxLength={REASON_MAX}
            className={textareaControlClassName}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={mutation.isPending}
          />
        )}
      </FormField>
    </ConfirmActionDialog>
  );
}
