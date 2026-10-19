"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import type { AssetRecord } from "@/lib/assets-api";
import {
  getInventory,
  type InventoryAction,
  type InventoryRecord,
} from "@/lib/inventories-api";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { StatusBadge } from "./inventories-table";
import { InventoryAssetsPanel } from "./inventory-assets-panel";
import { InventoryCheckDialog } from "./inventory-check-dialog";
import { InventoryItemsList } from "./inventory-items-list";
import { InventorySummaryPanel } from "./inventory-summary";
import { InventoryTransitionDialog } from "./inventory-transition-dialog";
import {
  acceptsChecks,
  canCancel,
  canClose,
  canStart,
  formatCalendarDate,
  formatDateTime,
  INVENTORY_STALE_MESSAGE,
  inventoriesQueryKey,
  inventoryDetailKey,
  inventoryErrorMessage,
  isInventoryNotFound,
  NO_LOCATED_UPDATE_NOTE,
  STATUS_HINT,
} from "./inventory-labels";

// =============================================================================
// Painel de detalhe do inventário (Sheet lateral). Fonte: `GET /inventories/<id>`
// (a linha da lista serve de esboço). Resumo calculado no servidor, itens
// conferidos e bens da unidade em abas. Ações (UX; o backend decide, ADM + AAL2):
// Iniciar, Encerrar e Cancelar — cada uma com ConfirmActionDialog que explica o
// efeito definitivo. Conferir bem: ADM e USER, só com o inventário EM ANDAMENTO.
// Inventários e conferências são imutáveis: não há editar nem excluir.
// 404 => "não encontrado ou fora do escopo" (mesma resposta para tudo).
// =============================================================================

type Section = "itens" | "bens";

const SECTIONS: readonly TabItem<Section>[] = [
  { id: "itens", label: "Itens conferidos" },
  { id: "bens", label: "Bens da unidade" },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="min-w-0 break-words text-body-sm text-bone [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function shortId(value: string): string {
  return `…${value.slice(-8)}`;
}

export interface InventoryDetailSheetProps {
  /** Linha selecionada na lista (esboço até o GET de detalhe responder). */
  inventory: InventoryRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  /** ADM e USER podem conferir (permissão `inventory.check`; o backend decide). */
  canCheck: boolean;
}

export function InventoryDetailSheet({ inventory: listInventory, open, onOpenChange, isAdmin, canCheck }: InventoryDetailSheetProps) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("itens");
  const [action, setAction] = useState<InventoryAction>("start");
  const [actionOpen, setActionOpen] = useState(false);
  const [checkAsset, setCheckAsset] = useState<AssetRecord | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const inventoryId = listInventory?.id ?? "";

  const detail = useQuery({
    queryKey: inventoryDetailKey(inventoryId),
    queryFn: () => getInventory(inventoryId),
    enabled: open && !!inventoryId,
    placeholderData: listInventory ?? undefined,
    retry: noClientRetry,
  });
  const inventory = detail.data;

  function reload() {
    void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
  }

  function openAction(next: InventoryAction) {
    setAction(next);
    setActionOpen(true);
  }

  function handleActionDone(saved: InventoryRecord | null) {
    if (saved) {
      setStale(false);
      queryClient.setQueryData(inventoryDetailKey(saved.id), saved);
    } else {
      setStale(true);
    }
    reload();
  }

  const status = inventory?.status;
  const checksOpen = acceptsChecks(status);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setStale(false);
          setActionOpen(false);
          setCheckOpen(false);
          setSection("itens");
        }
      }}
      title={<>Inventário {inventory?.name ?? listInventory?.name ?? "indisponível"}</>}
      description={
        inventory?.unit ? (
          <>
            <span translate="no">{inventory.unit.code}</span> — {inventory.unit.name}
          </>
        ) : undefined
      }
    >
      {detail.isError && isInventoryNotFound(detail.error) ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{inventoryErrorMessage(detail.error, "")}</FormMessage>
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
      ) : inventory ? (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={inventory.status} />
            </div>
            <p className="text-caption text-warm-granite">{STATUS_HINT[inventory.status]}</p>
          </div>

          {stale ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {INVENTORY_STALE_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          {detail.isError ? (
            <FormMessage>{inventoryErrorMessage(detail.error, "Não foi possível atualizar os dados deste inventário.")}</FormMessage>
          ) : null}

          <InventorySummaryPanel inventoryId={inventory.id} />

          {isAdmin && (canStart(status) || canClose(status) || canCancel(status)) ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Ações do inventário">
              {canStart(status) ? (
                <Button variant="outline" size="sm" onClick={() => openAction("start")}>
                  Iniciar
                </Button>
              ) : null}
              {canClose(status) ? (
                <Button variant="outline" size="sm" onClick={() => openAction("close")}>
                  Encerrar
                </Button>
              ) : null}
              {canCancel(status) ? (
                <Button variant="outline" size="sm" onClick={() => openAction("cancel")}>
                  Cancelar inventário
                </Button>
              ) : null}
            </div>
          ) : null}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Field label="Início">{formatCalendarDate(inventory.start_date) ?? "—"}</Field>
            {inventory.end_date ? <Field label="Término">{formatCalendarDate(inventory.end_date) ?? "—"}</Field> : null}
            <Field label="Criado em">{formatDateTime(inventory.created_at) ?? "—"}</Field>
            {inventory.closed_at ? (
              <Field label={inventory.status === "CANCELADO" ? "Cancelado em" : "Encerrado em"}>
                {formatDateTime(inventory.closed_at) ?? "—"}
              </Field>
            ) : null}
            <Field label="Criado por (identificador)">
              <span translate="no" className="font-mono">
                {shortId(inventory.created_by)}
              </span>
            </Field>
          </dl>

          <p className="text-caption text-warm-granite">{NO_LOCATED_UPDATE_NOTE}</p>
          <p className="text-caption text-warm-granite">
            Histórico imutável: inventários e conferências não podem ser editados nem excluídos, e cada bem é conferido uma
            única vez por inventário.
          </p>

          {!checksOpen ? (
            <p className="text-caption text-warm-granite" data-testid="checks-closed-note">
              {status === "ABERTO"
                ? "As conferências só são aceitas depois que o inventário for iniciado."
                : "Este inventário não aceita novas conferências."}
            </p>
          ) : null}

          <Tabs label="Seções do inventário" items={SECTIONS} value={section} onValueChange={setSection}>
            {section === "itens" ? (
              <InventoryItemsList inventoryId={inventory.id} unitId={inventory.unit_id} />
            ) : (
              <InventoryAssetsPanel
                inventoryId={inventory.id}
                unitId={inventory.unit_id}
                canCheck={canCheck && checksOpen}
                onCheck={(asset) => {
                  setCheckAsset(asset);
                  setCheckOpen(true);
                }}
              />
            )}
          </Tabs>

          <InventoryTransitionDialog
            open={actionOpen}
            onOpenChange={setActionOpen}
            inventory={inventory}
            action={action}
            onDone={handleActionDone}
          />

          {checkAsset ? (
            <InventoryCheckDialog
              open={checkOpen}
              onOpenChange={setCheckOpen}
              inventory={inventory}
              asset={checkAsset}
              onChecked={() => setStale(false)}
              onStale={() => {
                setStale(true);
                reload();
              }}
            />
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}
