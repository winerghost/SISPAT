"use client";

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RequiredLegend } from "@/components/ui/form-field";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import {
  createAsset,
  getAsset,
  updateAsset,
  type AssetRecord,
  type CreateAssetRequest,
} from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import {
  assetErrorMessage,
  ASSET_NOT_FOUND_MESSAGE,
  isAssetNotFound,
  isAssetVersionConflict,
  TECH_TYPE_LABEL,
} from "./asset-labels";
import { AssetChangesSummary, changedCountLabel } from "./asset-changes-summary";
import { AssetConflictNotice, type ConflictDifference } from "./asset-conflict-notice";
import { AssetEditActions } from "./asset-edit-actions";
import {
  buildPatch,
  CHANGE_LABEL,
  changedKeys,
  displayServerValue,
  displayValue,
  divergentKeys,
  mergeDraft,
  valuesFromAsset,
  type AssetFormValues,
  type ChangeContext,
  type DisplayLookups,
  type NamedOption,
} from "./asset-form-model";
import { AssetFormSections, type LookupState } from "./asset-form-sections";
import { useUnitPeople, useUnitRooms } from "./use-asset-lookups";

// =============================================================================
// Bem — criar (POST /assets) e editar (PATCH /assets/<id>).
//
// Campos por perfil (contrato docs/architecture/assets-api.md; a decisão real é
// do backend, que rejeita o resto com 400):
//   - USER: descrição, observações, sala, responsável, data de registro e
//     classificação. O número patrimonial aparece só como leitura na edição.
//   - ADM: tudo isso + número patrimonial (editável), "Localizado" e unidade
//     proprietária. A unidade só é escolhida na CRIAÇÃO.
//   - RH: somente leitura (nem chega a este formulário).
// O número patrimonial é TEXTO: nunca convertido nem formatado como número.
// `notes` só é exibido se a chave veio no registro (RH não a recebe).
// Edição envia SÓ os campos alterados + `version`. Local (`location_id`) não tem
// endpoint de listagem: a edição só permite mantê-lo ou removê-lo.
//
// RASCUNHO x SERVIDOR: o rascunho (`values`) é separado do registro do servidor.
// A base de comparação (`initial`) e a `version` só mudam quando o servidor é
// recarregado de propósito (409 ou "usar dados do servidor") — um refetch de
// fundo do painel NUNCA troca a version nem o que o usuário digitou. No 409 o
// rascunho é mantido, o servidor é relido e o aviso lista o que divergiu.
// Fechar com alterações pede confirmação (um único nível).
// =============================================================================

export const assetsQueryKey = ["assets"] as const;
export const assetDetailKey = (id: string) => [...assetsQueryKey, "detail", id] as const;

export interface AssetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = criar. */
  asset: AssetRecord | null;
  isAdmin: boolean;
  /** Unidades do escopo (`GET /units/accessible`). */
  units: AccessibleUnit[] | undefined;
  /** Unidade pré-selecionada na criação (filtro atual da lista). */
  defaultUnitId: string;
  /** 409 version_conflict ocorrido: o pai pode recarregar listas/detalhe. */
  onConflict: () => void;
  /** O conflito foi resolvido dentro do formulário (descartou o rascunho). */
  onConflictResolved?: () => void;
  onSaved: (saved: AssetRecord) => void;
}

export function AssetFormDialog(props: AssetFormDialogProps) {
  // Sem a version na chave: um refetch (ou 409) não pode remontar o formulário e apagar o rascunho.
  return <AssetFormBody key={props.asset ? props.asset.id : "novo"} {...props} />;
}

type FieldKey = "unit" | "patrimony";

function AssetFormBody({
  open,
  onOpenChange,
  asset,
  isAdmin,
  units,
  defaultUnitId,
  onConflict,
  onConflictResolved,
  onSaved,
}: AssetFormDialogProps) {
  const editing = !!asset;
  const queryClient = useQueryClient();
  const activeUnits = units?.filter((unit) => unit.active);

  // Base de comparação = registro do servidor com que o rascunho começou (ou foi reiniciado).
  const [baseAsset, setBaseAsset] = useState<AssetRecord | null>(asset);
  const [initial, setInitial] = useState<AssetFormValues>(() => valuesFromAsset(asset, defaultUnitId));
  const [values, setValues] = useState<AssetFormValues>(() => valuesFromAsset(asset, defaultUnitId));
  const [version, setVersion] = useState(asset?.version ?? 0);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [conflict, setConflict] = useState<{ differences: ConflictDifference[] } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [clearedTech, setClearedTech] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const confirmOpenerRef = useRef<HTMLElement | null>(null);
  const discardingRef = useRef(false);

  const hasNotes = !baseAsset || "notes" in baseAsset;
  const ctx: ChangeContext = { editing, hasNotes, isAdmin };
  const rooms = useUnitRooms(values.unitId, open, true);
  const people = useUnitPeople(values.unitId, open, true);
  const roomOptions = withCurrent(rooms.data?.rooms, baseAsset?.room);
  const personOptions = withCurrent(people.data?.people, baseAsset?.responsible_person);
  const ownerUnits = withCurrentUnit(activeUnits, baseAsset?.owner_unit);
  const lookups: DisplayLookups = {
    rooms: roomOptions,
    people: personOptions,
    units: ownerUnits,
    currentLocation: baseAsset?.location?.name ?? null,
  };

  const keys = changedKeys(initial, values, ctx);
  const changedSet = new Set(keys);
  const createTouched = !editing && JSON.stringify(values) !== JSON.stringify(valuesFromAsset(null, defaultUnitId));
  const isDirty = editing ? keys.length > 0 : createTouched;
  const summaryItems = keys.map((key) => ({
    key,
    label: CHANGE_LABEL[key],
    before: displayValue(key, initial, lookups),
    after: displayValue(key, values, lookups),
  }));

  const mutation = useMutation({
    mutationFn: () => {
      if (!asset) {
        const body: CreateAssetRequest = { unit_id: values.unitId, patrimony_number: values.patrimony.trim() };
        if (values.description.trim()) body.description = values.description.trim();
        if (hasNotes && values.notes.trim()) body.notes = values.notes.trim();
        if (values.roomId) body.room_id = values.roomId;
        if (values.personId) body.responsible_person_id = values.personId;
        if (values.registrationDate) body.registration_date = values.registrationDate;
        if (isAdmin) {
          if (values.ownerUnitId) body.owner_unit_id = values.ownerUnitId;
          if (values.located !== "DESCONHECIDO") body.located = values.located;
        }
        return createAsset(body);
      }
      // SÓ os campos alterados + version (a mesma lista do resumo na tela).
      return updateAsset(asset.id, buildPatch(values, keys, version));
    },
    onSuccess: (saved) => {
      toast.success(editing ? "Bem atualizado." : "Bem cadastrado.");
      void queryClient.invalidateQueries({ queryKey: assetsQueryKey });
      onSaved(saved);
      onOpenChange(false);
    },
    onError: (error) => {
      if (asset && isAssetVersionConflict(error)) {
        void reconcileWithServer(asset.id);
        return;
      }
      if (editing && isAssetNotFound(error)) {
        setNotFound(true);
        void queryClient.invalidateQueries({ queryKey: assetsQueryKey });
        return;
      }
      setFormError(assetErrorMessage(error, "Não foi possível salvar o bem agora. Tente novamente."));
    },
  });

  const busy = mutation.isPending || reconciling;

  /** 409: mantém o rascunho, relê o servidor e atualiza a version base. */
  async function reconcileWithServer(assetId: string) {
    setReconciling(true);
    setFormError(null);
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: assetDetailKey(assetId),
        queryFn: () => getAsset(assetId, { includeDeleted: isAdmin }),
        staleTime: 0,
      });
      const serverValues = valuesFromAsset(fresh, "");
      const differing = divergentKeys(initial, values, serverValues, ctx);
      setConflict({
        differences: differing.map((key) => ({
          key,
          label: CHANGE_LABEL[key],
          mine: displayValue(key, values, lookups),
          server: displayServerValue(key, fresh, lookups),
        })),
      });
      setValues(mergeDraft(initial, values, serverValues, ctx));
      setInitial(serverValues);
      setBaseAsset(fresh);
      setVersion(fresh.version);
      onConflict();
    } catch (error) {
      if (isAssetNotFound(error)) {
        setNotFound(true);
      } else {
        setFormError(assetErrorMessage(error, "Não foi possível recarregar os dados do bem. Tente salvar de novo."));
      }
      void queryClient.invalidateQueries({ queryKey: assetsQueryKey });
    } finally {
      setReconciling(false);
    }
  }

  function keepMyChanges() {
    setConflict(null);
    setFormError(null);
    mutation.mutate();
  }

  function discardDraftUseServer() {
    const fresh = baseAsset;
    if (!fresh) return;
    const serverValues = valuesFromAsset(fresh, "");
    setValues(serverValues);
    setInitial(serverValues);
    setConflict(null);
    setFormError(null);
    setClearedTech(null);
    setErrors({});
    onConflictResolved?.();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || notFound || (editing && keys.length === 0)) return;
    setFormError(null);
    const next: typeof errors = {};
    if (!editing && !values.unitId) next.unit = "Selecione a unidade.";
    if (!(editing && !isAdmin) && !values.patrimony.trim()) next.patrimony = "Informe o número patrimonial.";
    setErrors(next);
    const first = next.unit ? "bem-unidade" : next.patrimony ? "bem-numero" : null;
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    mutation.mutate();
  }

  function update<K extends keyof AssetFormValues>(key: K, value: AssetFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (key === "patrimony") setErrors((prev) => ({ ...prev, patrimony: undefined }));
    if (key === "techType" && value) setClearedTech(null);
  }

  function chooseUnit(unitId: string) {
    setValues((prev) => ({ ...prev, unitId, roomId: "", personId: "" }));
    setErrors((prev) => ({ ...prev, unit: undefined }));
  }

  function chooseCategory(category: AssetFormValues["category"]) {
    // Tipo de TI só existe em Tecnologia: avisa quando a troca o limpa.
    if (category !== "TECNOLOGIA" && values.techType) setClearedTech(TECH_TYPE_LABEL[values.techType]);
    setValues((prev) => ({
      ...prev,
      category,
      techType: category === "TECNOLOGIA" ? prev.techType : "",
    }));
  }

  function requestClose() {
    if (busy) return;
    if (isDirty) {
      confirmOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmOpen(true);
      return;
    }
    onOpenChange(false);
  }

  function discardAndClose() {
    discardingRef.current = true;
    setConfirmOpen(false);
    onOpenChange(false);
  }

  const lookupState = (options: NamedOption[], query: { isPending: boolean; isFetching: boolean; isError: boolean; refetch: () => unknown }): LookupState => ({
    options,
    loading: !!values.unitId && query.isPending && query.isFetching,
    error: !!values.unitId && query.isError,
    retry: () => void query.refetch(),
  });

  const submitLabel = editing ? "Salvar bem" : "Cadastrar bem";
  const serverError = notFound ? ASSET_NOT_FOUND_MESSAGE : formError;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
          onOpenAutoFocus={() => {
            // O botão que abriu o formulário (Editar) vive dentro do painel: guardamos para devolver o foco.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body) openerRef.current = active;
          }}
          onCloseAutoFocus={(event) => {
            const target = openerRef.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <DialogHeader className="shrink-0 px-card-padding pb-3 pt-card-padding">
            <DialogTitle>{editing ? "Editar bem" : "Novo bem"}</DialogTitle>
            <DialogDescription className="sr-only sm:not-sr-only">
              {editing
                ? isAdmin
                  ? "Altere os dados do bem. A unidade não pode ser trocada por aqui."
                  : "Altere descrição, observações, sala, responsável e data de registro. A unidade não pode ser trocada por aqui."
                : "O bem será cadastrado na unidade escolhida. O número patrimonial não pode se repetir entre bens ativos."}
            </DialogDescription>
          </DialogHeader>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit} noValidate aria-busy={busy || undefined}>
            {/* relative: contém os .sr-only (absolute) dentro da área rolável, sem esticar o diálogo. */}
            <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-card-padding pb-4 pt-1">
              <RequiredLegend surface="light" />
              {conflict ? (
                <AssetConflictNotice
                  differences={conflict.differences}
                  canKeep={keys.length > 0}
                  pending={busy}
                  onKeep={keepMyChanges}
                  onDiscard={discardDraftUseServer}
                />
              ) : null}
              <AssetChangesSummary items={summaryItems} />
              <AssetFormSections
                asset={baseAsset}
                values={values}
                changed={changedSet}
                errors={errors}
                pending={busy}
                isAdmin={isAdmin}
                hasNotes={hasNotes}
                activeUnits={activeUnits}
                ownerUnits={ownerUnits}
                rooms={lookupState(roomOptions, rooms)}
                people={lookupState(personOptions, people)}
                clearedTechLabel={clearedTech}
                onChange={update}
                onChooseUnit={chooseUnit}
                onChooseCategory={chooseCategory}
              />
            </div>
            <AssetEditActions
              editing={editing}
              changedCount={keys.length}
              pending={busy}
              blocked={notFound}
              submitLabel={submitLabel}
              error={serverError}
              onCancel={requestClose}
            />
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Descartar alterações?"
        description={
          editing ? `Você alterou ${changedCountLabel(keys.length)} neste bem.` : "O bem ainda não foi cadastrado."
        }
        consequences={["O que foi digitado ainda não foi salvo e será perdido se você descartar."]}
        confirmLabel="Descartar alterações"
        cancelLabel="Continuar editando"
        onConfirm={discardAndClose}
        onCloseAutoFocus={(event) => {
          // Continuar editando: o foco volta ao controle do formulário que o tinha.
          if (discardingRef.current) return;
          const target = confirmOpenerRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      />
    </>
  );
}

/** Opções do seletor + o vínculo atual do bem (que pode estar inativo ou fora da página de 200). */
function withCurrent(
  list: readonly { id: string; name: string }[] | undefined,
  current: { id: string; name: string } | null | undefined,
): NamedOption[] {
  const options = (list ?? []).map((item) => ({ id: item.id, name: item.name }));
  if (current && !options.some((option) => option.id === current.id)) {
    options.unshift({ id: current.id, name: current.name });
  }
  return options;
}

function withCurrentUnit(
  list: readonly AccessibleUnit[] | undefined,
  current: { id: string; code: string; name: string } | null | undefined,
): { id: string; code: string; name: string }[] {
  const options: { id: string; code: string; name: string }[] = [...(list ?? [])];
  if (current && !options.some((option) => option.id === current.id)) options.unshift(current);
  return options;
}
