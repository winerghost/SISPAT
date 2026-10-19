"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Sheet } from "@/components/ui/sheet";
import { getMovement, type MovementRecord } from "@/lib/movements-api";
import { PatrimonyNumber } from "@/components/features/assets/assets-table";
import { StatusBadge } from "./movements-table";
import { MovementDecisionDialog, type DecisionMode } from "./movement-decision-dialog";
import {
  destinationOf,
  formatDateTime,
  isMovementNotFound,
  MOVEMENT_STALE_MESSAGE,
  movementDetailKey,
  movementErrorMessage,
  movementsQueryKey,
  originOf,
  originVisibility,
  typeLabel,
} from "./movement-labels";

// =============================================================================
// Painel de detalhe da movimentação (Sheet lateral). Fonte:
// `GET /api/v1/movements/<id>` (a linha da lista serve de esboço). Campos
// opcionais só aparecem se a CHAVE veio: RH não recebe `reason`, `requested_by`
// nem `approved_by`. Origem → destino em texto claro. Ações (UX; o backend
// decide): Aprovar e Rejeitar só ADM, Cancelar para o solicitante ou ADM, sempre
// só em movimentação PENDENTE. Não existe editar nem excluir: o histórico é
// imutável. 404 => "não encontrada ou fora do escopo" (mesma resposta para tudo).
// =============================================================================

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-body-sm text-bone [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Side({
  heading,
  side,
}: {
  heading: string;
  side: { unit: string; room: string; person: string };
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-cards border border-ash-stroke p-4">
      <span className="text-eyebrow text-pale-stone">{heading}</span>
      <p className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">{side.unit}</p>
      <p className="break-words text-caption text-warm-granite [overflow-wrap:anywhere]">Sala: {side.room}</p>
      <p className="break-words text-caption text-warm-granite [overflow-wrap:anywhere]">Responsável: {side.person}</p>
    </div>
  );
}

/** Só o final do identificador (sem nome nem e-mail). */
function shortId(value: string): string {
  return `…${value.slice(-8)}`;
}

export interface MovementDetailSheetProps {
  /** Linha selecionada na lista (esboço até o GET de detalhe responder). */
  movement: MovementRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  /** ADM e USER podem solicitar/cancelar (a decisão real é do backend). */
  canWrite: boolean;
  /** Id do usuário logado (`/me`), só para mostrar "Cancelar" ao solicitante. */
  meId: string | undefined;
}

export function MovementDetailSheet({ movement: listMovement, open, onOpenChange, isAdmin, canWrite, meId }: MovementDetailSheetProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<DecisionMode>("approve");
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const movementId = listMovement?.id ?? "";

  const detail = useQuery({
    queryKey: movementDetailKey(movementId),
    queryFn: () => getMovement(movementId),
    enabled: open && !!movementId,
    placeholderData: listMovement ?? undefined,
    retry: false,
  });
  const movement = detail.data;

  function reload() {
    void queryClient.invalidateQueries({ queryKey: movementsQueryKey });
  }

  function openDecision(next: DecisionMode) {
    setMode(next);
    setDecisionOpen(true);
  }

  function handleDone(saved: MovementRecord | null) {
    if (saved) {
      setStale(false);
      queryClient.setQueryData(movementDetailKey(saved.id), saved);
    } else {
      setStale(true);
    }
    reload();
  }

  const pendingState = movement?.status === "PENDENTE";
  const isRequester = !!movement && !!meId && "requested_by" in movement && movement.requested_by === meId;
  const canDecide = isAdmin && pendingState;
  const canCancel = canWrite && pendingState && (isAdmin || isRequester);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setStale(false);
          setDecisionOpen(false);
        }
      }}
      title={
        <>
          Movimentação do patrimônio{" "}
          <PatrimonyNumber
            value={movement?.asset?.patrimony_number ?? listMovement?.asset?.patrimony_number ?? "indisponível"}
            className="text-body"
          />
        </>
      }
      description={movement?.asset?.description ?? undefined}
    >
      {detail.isError && isMovementNotFound(detail.error) ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{movementErrorMessage(detail.error, "")}</FormMessage>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reload();
              onOpenChange(false);
            }}
          >
            Voltar à lista
          </Button>
        </div>
      ) : movement ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={movement.status} />
            <span className="text-caption text-warm-granite">{typeLabel(movement.movement_type)}</span>
          </div>

          {stale ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {MOVEMENT_STALE_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          {detail.isError ? (
            <FormMessage>{movementErrorMessage(detail.error, "Não foi possível atualizar os dados desta movimentação.")}</FormMessage>
          ) : null}

          {movement.asset?.deleted ? (
            <FormMessage>Este bem foi excluído (exclusão lógica). A movimentação não pode ser aprovada.</FormMessage>
          ) : null}

          <section aria-label="Origem e destino" className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <Side heading="Origem" side={originOf(movement)} />
            <div className="flex items-center justify-center text-warm-granite" aria-hidden="true">
              <ArrowDown className="h-5 w-5 sm:hidden" />
              <ArrowRight className="hidden h-5 w-5 sm:block" />
            </div>
            <Side heading="Destino" side={destinationOf(movement)} />
          </section>
          <p className="text-caption text-warm-granite">
            Leitura: o bem sai da <strong className="font-normal text-pale-stone">origem</strong> e vai para o{" "}
            <strong className="font-normal text-pale-stone">destino</strong>. Nada muda no bem até a aprovação.
          </p>

          {!originVisibility(movement).room || !originVisibility(movement).person ? (
            <p className="text-caption text-warm-granite" data-testid="origin-scope-note">
              A unidade de origem está fora do seu escopo: a sala e o responsável de origem, e o motivo, não são exibidos.
            </p>
          ) : null}

          {canDecide || canCancel ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Ações da movimentação">
              {canDecide ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => openDecision("approve")}>
                    Aprovar
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openDecision("reject")}>
                    Rejeitar
                  </Button>
                </>
              ) : null}
              {canCancel ? (
                <Button variant="outline" size="sm" onClick={() => openDecision("cancel")}>
                  Cancelar solicitação
                </Button>
              ) : null}
            </div>
          ) : null}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Field label="Solicitada em">{formatDateTime(movement.created_at) ?? "—"}</Field>
            {movement.approved_at ? (
              <Field label={movement.status === "REJEITADA" ? "Rejeitada em" : "Aprovada em"}>
                {formatDateTime(movement.approved_at) ?? "—"}
              </Field>
            ) : null}
            {movement.completed_at ? <Field label="Concluída em">{formatDateTime(movement.completed_at) ?? "—"}</Field> : null}
            {"requested_by" in movement && movement.requested_by ? (
              <Field label="Solicitante (identificador)">
                <span translate="no" className="font-mono">
                  {shortId(movement.requested_by)}
                </span>
              </Field>
            ) : null}
            {"approved_by" in movement && movement.approved_by ? (
              <Field label={movement.status === "REJEITADA" ? "Rejeitada por (identificador)" : "Aprovada por (identificador)"}>
                <span translate="no" className="font-mono">
                  {shortId(movement.approved_by)}
                </span>
              </Field>
            ) : null}
            {"reason" in movement && movement.reason ? <Field label="Motivo da solicitação">{movement.reason}</Field> : null}
          </dl>

          <p className="text-caption text-warm-granite">
            Histórico imutável: uma movimentação não pode ser editada nem excluída; só a decisão única (aprovar, rejeitar ou
            cancelar) é registrada.
          </p>

          <MovementDecisionDialog
            open={decisionOpen}
            onOpenChange={setDecisionOpen}
            movement={movement}
            mode={mode}
            onDone={handleDone}
          />
        </>
      ) : null}
    </Sheet>
  );
}
