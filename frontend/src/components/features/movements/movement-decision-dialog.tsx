"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, textareaControlClassName } from "@/components/ui/form-field";
import { getAsset } from "@/lib/assets-api";
import {
  approveMovement,
  cancelMovement,
  rejectMovement,
  type MovementRecord,
} from "@/lib/movements-api";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import {
  blankToUndefined,
  isMovementNotFound,
  isMovementVersionConflict,
  MOVEMENT_VERSION_CONFLICT_MESSAGE,
  movementErrorMessage,
  movementsQueryKey,
  originVisibility,
  REASON_MAX,
  unitRefText,
} from "./movement-labels";
import { errorCode } from "@/components/features/users/user-labels";
import { ApiError } from "@/lib/api-client";

// =============================================================================
// Aprovar / rejeitar (só ADM + AAL2; o backend decide) e cancelar (solicitante
// ou ADM). Cada ação é uma transição ÚNICA e irreversível: o histórico é
// imutável. Aprovar altera o bem de forma definitiva e envia `asset_version`
// (a versão do bem que o aprovador está VENDO, lida ao abrir o diálogo); rejeitar
// e cancelar enviam só o motivo (vai para a auditoria). O sucesso só é exibido
// depois da resposta; 409 `version_conflict` recarrega o bem e avisa, 409
// `invalid_transition` fecha e recarrega a movimentação.
// =============================================================================

export type DecisionMode = "approve" | "reject" | "cancel";

const APPROVE_CONSEQUENCES = [
  "A aprovação ALTERA O BEM de forma definitiva: unidade, sala e responsável passam a ser os do destino.",
  "A movimentação não pode ser desfeita nem editada: o histórico é imutável. Para voltar, é preciso solicitar uma nova movimentação.",
  "A aprovação só é aplicada se o bem não mudou desde a solicitação; se mudou, ela é recusada e nada é alterado.",
  "A decisão e o autor ficam registrados na auditoria.",
];

const REJECT_CONSEQUENCES = [
  "A movimentação passa a REJEITADA e o bem NÃO é alterado.",
  "A decisão é definitiva e o histórico é imutável: não é possível reabrir esta solicitação, apenas criar outra.",
  "O motivo informado fica na auditoria.",
];

const CANCEL_CONSEQUENCES = [
  "A solicitação passa a CANCELADA e o bem NÃO é alterado.",
  "O cancelamento é definitivo e o histórico é imutável: para movimentar o bem, será preciso criar outra solicitação.",
];

const COPY: Record<
  DecisionMode,
  { title: string; confirm: string; pending: string; consequences: string[]; success: string; failure: string }
> = {
  approve: {
    title: "Aprovar movimentação",
    confirm: "Aprovar e alterar o bem",
    pending: "Aprovando…",
    consequences: APPROVE_CONSEQUENCES,
    success: "Movimentação aprovada. O bem foi atualizado.",
    failure: "Não foi possível aprovar a movimentação agora. Tente novamente.",
  },
  reject: {
    title: "Rejeitar movimentação",
    confirm: "Rejeitar movimentação",
    pending: "Rejeitando…",
    consequences: REJECT_CONSEQUENCES,
    success: "Movimentação rejeitada. O bem não foi alterado.",
    failure: "Não foi possível rejeitar a movimentação agora. Tente novamente.",
  },
  cancel: {
    title: "Cancelar solicitação",
    confirm: "Cancelar solicitação",
    pending: "Cancelando…",
    consequences: CANCEL_CONSEQUENCES,
    success: "Solicitação cancelada. O bem não foi alterado.",
    failure: "Não foi possível cancelar a solicitação agora. Tente novamente.",
  },
};

export function MovementDecisionDialog({
  open,
  onOpenChange,
  movement,
  mode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  movement: MovementRecord;
  mode: DecisionMode;
  /** `saved` = registro devolvido pelo backend; `null` = estado mudou (recarregar a movimentação). */
  onDone: (saved: MovementRecord | null) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const copy = COPY[mode];
  const isApprove = mode === "approve";
  const reasonRequired = mode === "reject";

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
      setReasonError(null);
    }
  }, [open]);

  // Aprovar: lê o bem agora (versão + situação atual) para que o ADM veja o que vai alterar.
  const assetQuery = useQuery({
    queryKey: ["movements", "approve-asset", movement.asset_id],
    queryFn: () => getAsset(movement.asset_id),
    enabled: open && isApprove,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const asset = assetQuery.data;
  // Sala/responsável de origem só são comparados quando as CHAVES vieram: ausentes
  // (origem fora do escopo) não significam "sem sala", e não geram aviso falso.
  const visible = originVisibility(movement);
  const drifted =
    !!asset &&
    (asset.unit_id !== movement.origin_unit_id ||
      (visible.room && (asset.room_id ?? null) !== (movement.origin_room_id ?? null)) ||
      (visible.person && (asset.responsible_person_id ?? null) !== (movement.previous_responsible_id ?? null)));

  const mutation = useMutation({
    mutationFn: () => {
      const text = blankToUndefined(reason);
      if (mode === "approve") return approveMovement(movement.id, { asset_version: asset!.version });
      if (mode === "reject") return rejectMovement(movement.id, text ? { reason: text } : {});
      return cancelMovement(movement.id, text ? { reason: text } : {});
    },
    onSuccess: (saved) => {
      toast.success(copy.success);
      void queryClient.invalidateQueries({ queryKey: movementsQueryKey });
      if (isApprove) void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onOpenChange(false);
      onDone(saved);
    },
    onError: (err) => {
      if (isMovementVersionConflict(err)) {
        // Recarrega o bem (nova versão/situação) e mantém o diálogo para nova revisão.
        void assetQuery.refetch();
        void queryClient.invalidateQueries({ queryKey: movementsQueryKey });
        setError(MOVEMENT_VERSION_CONFLICT_MESSAGE);
        return;
      }
      if (err instanceof ApiError && err.status === 409 && errorCode(err) === "invalid_transition") {
        toast.error(movementErrorMessage(err, copy.failure));
        onOpenChange(false);
        onDone(null);
        return;
      }
      if (isMovementNotFound(err)) {
        onOpenChange(false);
        toast.error(movementErrorMessage(err, copy.failure));
        onDone(null);
        return;
      }
      setError(movementErrorMessage(err, copy.failure));
    },
  });

  const approveBlocked = isApprove && (assetQuery.isPending || assetQuery.isError);

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={
        <>
          Bem:{" "}
          <span translate="no" className="font-mono">
            {movement.asset?.patrimony_number ?? "indisponível"}
          </span>
          . De {unitRefText(movement.origin_unit)} para {unitRefText(movement.destination_unit)}.
        </>
      }
      consequences={copy.consequences}
      confirmLabel={copy.confirm}
      pendingLabel={copy.pending}
      pending={mutation.isPending}
      confirmDisabled={approveBlocked}
      error={error}
      onConfirm={() => {
        setError(null);
        if (reasonRequired && !blankToUndefined(reason)) {
          setReasonError("Informe o motivo da rejeição.");
          document.getElementById("mov-decisao-motivo")?.focus();
          return;
        }
        setReasonError(null);
        mutation.mutate();
      }}
    >
      {isApprove ? (
        <div className="flex flex-col gap-1 text-body-sm text-obsidian-canvas" aria-live="polite">
          {assetQuery.isPending ? <p>Lendo a situação atual do bem…</p> : null}
          {assetQuery.isError ? (
            <p>
              Não foi possível ler a situação atual do bem, então a aprovação está bloqueada. Feche e tente de novo mais
              tarde.
            </p>
          ) : null}
          {asset ? (
            <>
              <p>
                Situação atual do bem: {unitRefText(asset.unit)} · {asset.room?.name ?? "sem sala"} ·{" "}
                {asset.responsible_person?.name ?? "sem responsável"}.
              </p>
              {drifted ? (
                <p>
                  O bem mudou desde a solicitação: a aprovação provavelmente será recusada. Se for, rejeite ou peça uma
                  nova solicitação.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {!isApprove ? (
        <FormField
          id="mov-decisao-motivo"
          label={reasonRequired ? "Motivo da rejeição" : "Motivo (opcional)"}
          required={reasonRequired}
          error={reasonError}
          surface="light"
          hint="Até 500 caracteres. Fica na auditoria."
        >
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
      ) : null}
    </ConfirmActionDialog>
  );
}
