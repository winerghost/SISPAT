"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { getAsset, type AssetRecord } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { BondStatusText, DeletedBadge, LocatedBadge, PatrimonyNumber } from "./assets-table";
import {
  assetErrorMessage,
  ASSET_VERSION_CONFLICT_MESSAGE,
  formatCalendarDate,
  formatDateTime,
  isAssetNotFound,
  unitRefText,
} from "./asset-labels";
import { assetDetailKey, assetsQueryKey, AssetFormDialog } from "./asset-form-dialog";
import { AssetHistoryList } from "./asset-history-list";
import { AssetLifecycleDialog, type LifecycleMode } from "./asset-lifecycle-dialog";

// =============================================================================
// Painel de detalhe do bem (Sheet lateral): abas "Dados" e "Histórico".
// Fonte: `GET /api/v1/assets/<id>` (a linha da lista serve de esboço até a
// resposta chegar). Campos opcionais só aparecem se a CHAVE veio (RH não recebe
// `notes` etc.). Ações: Editar (ADM/USER), Excluir e Restaurar (só ADM, sempre
// com confirmação que explica a exclusão LÓGICA) — esconder botões é só UX, o
// backend decide. 409 `version_conflict` => recarrega o registro e avisa; 404 =>
// "não encontrado ou fora do escopo" (o backend não diferencia, de propósito).
// =============================================================================

type Section = "dados" | "historico";

const SECTIONS: readonly TabItem<Section>[] = [
  { id: "dados", label: "Dados" },
  { id: "historico", label: "Histórico" },
];

export interface AssetDetailSheetProps {
  /** Linha selecionada na lista (esboço até o GET de detalhe responder). */
  asset: AssetRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  /** ADM e USER podem editar (a decisão real é do backend). */
  canWrite: boolean;
  units: AccessibleUnit[] | undefined;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-body-sm text-bone [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function AssetDetailSheet({ asset: listAsset, open, onOpenChange, isAdmin, canWrite, units }: AssetDetailSheetProps) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("dados");
  const [conflict, setConflict] = useState(false);
  const [editing, setEditing] = useState(false);
  // Contador: cada abertura do formulário o remonta (descarta edições antigas).
  const [editSession, setEditSession] = useState(0);
  const [lifecycleMode, setLifecycleMode] = useState<LifecycleMode>("delete");
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const assetId = listAsset?.id ?? "";

  const detail = useQuery({
    queryKey: assetDetailKey(assetId),
    queryFn: () => getAsset(assetId, { includeDeleted: isAdmin }),
    enabled: open && !!assetId,
    placeholderData: listAsset ?? undefined,
    retry: false,
  });
  const asset = detail.data;

  function reload() {
    void queryClient.invalidateQueries({ queryKey: assetsQueryKey });
  }

  function handleSaved(saved: AssetRecord) {
    setConflict(false);
    queryClient.setQueryData(assetDetailKey(saved.id), saved);
  }

  function handleConflict() {
    setConflict(true);
    reload();
  }

  function openLifecycle(mode: LifecycleMode) {
    setLifecycleMode(mode);
    setLifecycleOpen(true);
  }

  function handleLifecycleDone(saved: AssetRecord | null) {
    if (saved) {
      setConflict(false);
      queryClient.setQueryData(assetDetailKey(saved.id), saved);
      reload();
    } else {
      handleConflict();
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setConflict(false);
          setSection("dados");
          setEditing(false);
          setLifecycleOpen(false);
        }
      }}
      title={
        <>
          Patrimônio <PatrimonyNumber value={asset?.patrimony_number ?? listAsset?.patrimony_number ?? ""} className="text-body" />
        </>
      }
      description={asset?.description ?? undefined}
    >
      {detail.isError && isAssetNotFound(detail.error) ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{assetErrorMessage(detail.error, "")}</FormMessage>
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
      ) : asset ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <LocatedBadge located={asset.located} />
            {asset.deleted_at ? <DeletedBadge /> : null}
          </div>

          {conflict ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {ASSET_VERSION_CONFLICT_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          {detail.isError ? (
            <FormMessage>{assetErrorMessage(detail.error, "Não foi possível atualizar os dados deste bem.")}</FormMessage>
          ) : null}

          <div className="flex flex-wrap gap-2" role="group" aria-label="Ações do bem">
            {canWrite && !asset.deleted_at ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditSession((n) => n + 1);
                  setEditing(true);
                }}
              >
                Editar
              </Button>
            ) : null}
            {isAdmin && !asset.deleted_at ? (
              <Button variant="outline" size="sm" onClick={() => openLifecycle("delete")}>
                Excluir
              </Button>
            ) : null}
            {isAdmin && asset.deleted_at ? (
              <Button variant="outline" size="sm" onClick={() => openLifecycle("restore")}>
                Restaurar
              </Button>
            ) : null}
          </div>

          <Tabs label="Seções do bem" items={SECTIONS} value={section} onValueChange={setSection}>
            {section === "dados" ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <Field label="Unidade">{unitRefText(asset.unit)}</Field>
                <Field label="Unidade proprietária">{unitRefText(asset.owner_unit)}</Field>
                <Field label="Descrição">{asset.description ?? "—"}</Field>
                <Field label="Sala">{asset.room?.name ?? "—"}</Field>
                <Field label="Local">{asset.location?.name ?? "—"}</Field>
                <Field label="Responsável">{asset.responsible_person?.name ?? "—"}</Field>
                <Field label="Vínculo">
                  <BondStatusText value={asset.bond_status} />
                </Field>
                <Field label="Data de registro">{formatCalendarDate(asset.registration_date) ?? "—"}</Field>
                {"notes" in asset ? <Field label="Observações">{asset.notes ?? "—"}</Field> : null}
                <Field label="Criado em">{formatDateTime(asset.created_at) ?? "—"}</Field>
                <Field label="Atualizado em">{formatDateTime(asset.updated_at) ?? "—"}</Field>
                {asset.deleted_at ? <Field label="Excluído em">{formatDateTime(asset.deleted_at) ?? "—"}</Field> : null}
              </dl>
            ) : (
              <AssetHistoryList key={asset.id} assetId={asset.id} includeDeleted={isAdmin} />
            )}
          </Tabs>

          {editSession > 0 ? (
            <AssetFormDialog
              key={editSession}
              open={editing}
              onOpenChange={setEditing}
              asset={asset}
              isAdmin={isAdmin}
              units={units}
              defaultUnitId=""
              conflict={conflict}
              onConflict={handleConflict}
              onSaved={handleSaved}
            />
          ) : null}
          <AssetLifecycleDialog
            open={lifecycleOpen}
            onOpenChange={setLifecycleOpen}
            asset={asset}
            mode={lifecycleMode}
            onDone={handleLifecycleDone}
          />
        </>
      ) : null}
    </Sheet>
  );
}
