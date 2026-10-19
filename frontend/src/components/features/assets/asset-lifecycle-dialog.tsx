"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, textareaControlClassName } from "@/components/ui/form-field";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import { deleteAsset, restoreAsset, type AssetRecord } from "@/lib/assets-api";
import { assetErrorMessage, blankToNull, isAssetVersionConflict, REASON_MAX } from "./asset-labels";

// =============================================================================
// Excluir / restaurar bem (somente ADM; o backend decide). A exclusão é LÓGICA:
// o registro, o histórico e a auditoria são preservados — não existe exclusão
// física. Envia `version` (controle otimista) e motivo opcional (≤500, vai para
// a auditoria). O sucesso só é exibido após a resposta do backend; 409
// `version_conflict` fecha o diálogo e pede ao pai para recarregar o registro.
// =============================================================================

export type LifecycleMode = "delete" | "restore";

const DELETE_CONSEQUENCES = [
  "O bem NÃO é apagado: é uma exclusão LÓGICA. O registro, o histórico e a auditoria são preservados.",
  "Ele deixa de aparecer na lista e na busca; só administradores o veem ao marcar “Incluir excluídos”.",
  "O número patrimonial fica livre para outro bem enquanto este estiver excluído.",
  "Você pode restaurar o bem depois; se o número tiver sido reutilizado, a restauração será recusada.",
];

const RESTORE_CONSEQUENCES = [
  "O bem volta a aparecer na lista e na busca, com o histórico preservado.",
  "Se o número patrimonial já estiver em uso por outro bem ativo, a restauração será recusada.",
];

export function AssetLifecycleDialog({
  open,
  onOpenChange,
  asset,
  mode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetRecord;
  mode: LifecycleMode;
  /** `saved` = registro devolvido pelo backend; `null` = conflito de versão (recarregar). */
  onDone: (saved: AssetRecord | null) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  const isDelete = mode === "delete";
  const mutation = useMutation({
    mutationFn: () => {
      const payload = { version: asset.version, reason: blankToNull(reason) ?? undefined };
      return isDelete ? deleteAsset(asset.id, payload) : restoreAsset(asset.id, payload);
    },
    onSuccess: (saved) => {
      toast.success(isDelete ? "Bem excluído (exclusão lógica). O registro foi preservado." : "Bem restaurado.");
      onOpenChange(false);
      onDone(saved);
    },
    onError: (err) => {
      if (isAssetVersionConflict(err)) {
        onOpenChange(false);
        toast.error("Outra pessoa alterou este bem. Os dados foram recarregados — revise e tente de novo.");
        onDone(null);
        return;
      }
      setError(
        assetErrorMessage(
          err,
          isDelete ? "Não foi possível excluir o bem agora. Tente novamente." : "Não foi possível restaurar o bem agora. Tente novamente.",
        ),
      );
    },
  });

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isDelete ? "Excluir bem (exclusão lógica)" : "Restaurar bem"}
      description={
        <>
          Bem selecionado: <span translate="no">{asset.patrimony_number}</span>
        </>
      }
      consequences={isDelete ? DELETE_CONSEQUENCES : RESTORE_CONSEQUENCES}
      confirmLabel={isDelete ? "Excluir bem" : "Restaurar bem"}
      pendingLabel={isDelete ? "Excluindo…" : "Restaurando…"}
      pending={mutation.isPending}
      error={error}
      onConfirm={() => {
        setError(null);
        mutation.mutate();
      }}
    >
      <FormField id="bem-motivo" label="Motivo (opcional)" surface="light" hint="Até 500 caracteres. Fica na auditoria.">
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
