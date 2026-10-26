"use client";

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Link2 } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { getAsset, type AssetRecord } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { cn } from "@/lib/utils";
import { BondStatusText, DeletedBadge, LocatedBadge, PatrimonyNumber } from "./assets-table";
import {
  assetErrorMessage,
  ASSET_VERSION_CONFLICT_MESSAGE,
  CATEGORY_LABEL,
  classificationLabel,
  formatCalendarDate,
  formatDateTime,
  OPERATIONAL_STATUS_LABEL,
  TECH_TYPE_LABEL,
  isAssetNotFound,
  unitRefText,
} from "./asset-labels";
import { assetDetailKey, assetsQueryKey, AssetFormDialog } from "./asset-form-dialog";
import { AssetHistoryList } from "./asset-history-list";
import { AssetLifecycleDialog, type LifecycleMode } from "./asset-lifecycle-dialog";

// =============================================================================
// Painel de detalhe do bem (Sheet lateral): abas "Dados" e "Histórico".
// Fonte: `GET /api/v1/assets/<id>` (a linha da lista serve de esboço até a
// resposta chegar; sem esboço, mostra um esqueleto). Campos opcionais só
// aparecem se a CHAVE veio (RH não recebe `notes` etc.).
//
// Cabeçalho: eyebrow "PATRIMÔNIO", número em Geist Mono grande (texto, nunca
// convertido) e selos com ícone + texto. Corpo em cartões (borda ash-stroke, sem
// sombra): Identificação, Localização e responsável, Classificação técnica,
// Vínculo, Registro e Observações. Ações numa barra fixa no rodapé do painel:
// Editar (ADM/USER) é a ação primária; Excluir e Restaurar (só ADM, sempre com
// confirmação que explica a exclusão LÓGICA) ficam em outline, separadas —
// esconder botões é só UX, o backend decide. 409 `version_conflict` => recarrega
// o registro e avisa (uma única vez: com o formulário aberto o aviso fica nele);
// 404 => "não encontrado ou fora do escopo" (o backend não diferencia, de propósito).
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

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", wide && "sm:col-span-2")}>
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-body-sm text-bone [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function DetailCard({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-cards border border-ash-stroke p-4 sm:p-card-padding">
      {title ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="text-eyebrow text-warm-granite">{title}</h3>
          {aside}
        </div>
      ) : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Carregando os dados do bem…</span>
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          aria-hidden="true"
          className="flex animate-pulse flex-col gap-3 rounded-cards border border-ash-stroke p-4 motion-reduce:animate-none"
        >
          <div className="h-3 w-1/3 rounded-sm bg-carbon-lift" />
          <div className="h-4 w-full rounded-sm bg-carbon-lift" />
          <div className="h-4 w-2/3 rounded-sm bg-carbon-lift" />
        </div>
      ))}
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

  const notFound = detail.isError && isAssetNotFound(detail.error);
  const canEdit = canWrite && !!asset && !asset.deleted_at;
  const canDelete = isAdmin && !!asset && !asset.deleted_at;
  const canRestore = isAdmin && !!asset && !!asset.deleted_at;
  const hasActions = canEdit || canDelete || canRestore;
  const numberText = asset?.patrimony_number ?? listAsset?.patrimony_number ?? "";

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
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-eyebrow text-pale-stone">Patrimônio</span>{" "}
          <PatrimonyNumber
            value={numberText}
            className="text-[1.75rem] leading-[1.1] tracking-[-0.04em] text-bone sm:text-heading"
          />
        </span>
      }
      meta={
        asset && !notFound ? (
          <>
            <LocatedBadge located={asset.located} />
            {asset.deleted_at ? <DeletedBadge /> : null}
            {asset.operational_status ? (
              <Badge variant="outline">
                <Activity aria-hidden="true" />
                {classificationLabel(OPERATIONAL_STATUS_LABEL, asset.operational_status)}
              </Badge>
            ) : null}
            {asset.bond_status ? (
              <Badge variant="outline" className="max-w-full">
                <Link2 aria-hidden="true" />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">Vínculo: {asset.bond_status}</span>
              </Badge>
            ) : null}
          </>
        ) : undefined
      }
      description={
        asset?.description && !notFound ? (
          <span className="line-clamp-2">{asset.description}</span>
        ) : undefined
      }
      footer={
        hasActions ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center" role="group" aria-label="Ações do bem">
            {canEdit ? (
              <Button
                variant="light"
                size="lg"
                onClick={() => {
                  setEditSession((n) => n + 1);
                  setEditing(true);
                }}
              >
                Editar
              </Button>
            ) : null}
            {canDelete ? (
              <Button variant="outline" size="lg" className="sm:ml-auto" onClick={() => openLifecycle("delete")}>
                Excluir
              </Button>
            ) : null}
            {canRestore ? (
              <Button variant="outline" size="lg" className="sm:ml-auto" onClick={() => openLifecycle("restore")}>
                Restaurar
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {notFound ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{assetErrorMessage(detail.error, "")}</FormMessage>
          <Button
            variant="outline"
            size="lg"
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
          {conflict && !editing ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {ASSET_VERSION_CONFLICT_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          {detail.isError ? (
            <FormMessage>{assetErrorMessage(detail.error, "Não foi possível atualizar os dados deste bem.")}</FormMessage>
          ) : null}

          <Tabs label="Seções do bem" items={SECTIONS} value={section} onValueChange={setSection}>
            {section === "dados" ? (
              <div className="flex min-w-0 flex-col gap-4">
                <DetailCard title="Identificação">
                  <Field label="Unidade">{unitRefText(asset.unit)}</Field>
                  <Field label="Unidade proprietária">{unitRefText(asset.owner_unit)}</Field>
                  <Field label="Descrição" wide>
                    {asset.description ?? "—"}
                  </Field>
                  <Field label="Data de registro">{formatCalendarDate(asset.registration_date) ?? "—"}</Field>
                </DetailCard>

                <DetailCard title="Localização e responsável">
                  <Field label="Sala">{asset.room?.name ?? "—"}</Field>
                  <Field label="Local">{asset.location?.name ?? "—"}</Field>
                  <Field label="Responsável">{asset.responsible_person?.name ?? "—"}</Field>
                </DetailCard>

                <DetailCard title="Classificação técnica">
                  <Field label="Categoria">{classificationLabel(CATEGORY_LABEL, asset.asset_category)}</Field>
                  {asset.asset_category === "TECNOLOGIA" ? (
                    <Field label="Tipo de TI">{classificationLabel(TECH_TYPE_LABEL, asset.tech_type)}</Field>
                  ) : null}
                  <Field label="Situação operacional">
                    {classificationLabel(OPERATIONAL_STATUS_LABEL, asset.operational_status)}
                  </Field>
                </DetailCard>

                <DetailCard title="Vínculo">
                  <Field label="Vínculo" wide>
                    <BondStatusText value={asset.bond_status} />
                  </Field>
                </DetailCard>

                <DetailCard
                  title="Registro"
                  aside={
                    <span translate="no" className="font-mono text-eyebrow text-pale-stone">
                      Revisão {asset.version}
                    </span>
                  }
                >
                  <Field label="Criado em">{formatDateTime(asset.created_at) ?? "—"}</Field>
                  <Field label="Atualizado em">{formatDateTime(asset.updated_at) ?? "—"}</Field>
                  {asset.deleted_at ? <Field label="Excluído em">{formatDateTime(asset.deleted_at) ?? "—"}</Field> : null}
                </DetailCard>

                {"notes" in asset ? (
                  <DetailCard>
                    <Field label="Observações" wide>
                      {asset.notes ?? "—"}
                    </Field>
                  </DetailCard>
                ) : null}
              </div>
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
              onConflict={handleConflict}
              onConflictResolved={() => setConflict(false)}
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
      ) : detail.isPending ? (
        <DetailSkeleton />
      ) : null}
    </Sheet>
  );
}
