"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import {
  createAsset,
  updateAsset,
  type AssetCategory,
  type AssetRecord,
  type CreateAssetRequest,
  type LocatedStatus,
  type OperationalStatus,
  type TechType,
  type UpdateAssetRequest,
} from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { CatalogFormDialog } from "@/components/features/catalog/catalog-dialogs";
import { ReadOnlyField } from "@/components/features/catalog/catalog-parts";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import {
  assetErrorMessage,
  ASSET_NOT_FOUND_MESSAGE,
  ASSET_VERSION_CONFLICT_MESSAGE,
  blankToNull,
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  isAssetNotFound,
  isAssetVersionConflict,
  LOCATED_LABEL,
  LOCATED_OPTIONS,
  NOT_INFORMED_LABEL,
  OPERATIONAL_STATUS_LABEL,
  OPERATIONAL_STATUS_OPTIONS,
  PATRIMONY_MAX,
  TECH_TYPE_LABEL,
  TECH_TYPE_OPTIONS,
  TEXT_MAX,
  unitRefText,
} from "./asset-labels";
import { useUnitPeople, useUnitRooms } from "./use-asset-lookups";

// =============================================================================
// Bem — criar (POST /assets) e editar (PATCH /assets/<id>).
//
// Campos por perfil (contrato docs/architecture/assets-api.md; a decisão real é
// do backend, que rejeita o resto com 400):
//   - USER: descrição, observações, sala, responsável e data de registro. O
//     número patrimonial aparece só como leitura na edição.
//   - ADM: tudo isso + número patrimonial (editável), "Localizado" e unidade
//     proprietária. A unidade só é escolhida na CRIAÇÃO.
//   - RH: somente leitura (nem chega a este formulário).
// O número patrimonial é TEXTO: nunca convertido nem formatado como número.
// `notes` só é exibido se a chave veio no registro (RH não a recebe).
// Edição envia SÓ os campos alterados + `version`. Local (`location_id`) não tem
// endpoint de listagem: a edição só permite mantê-lo ou removê-lo.
// =============================================================================

export const assetsQueryKey = ["assets"] as const;
export const assetDetailKey = (id: string) => [...assetsQueryKey, "detail", id] as const;

type FieldKey = "unit" | "patrimony";

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
  /** 409 version_conflict ocorrido: mostra o aviso (o pai recarrega o detalhe e o formulário reinicia). */
  conflict: boolean;
  onConflict: () => void;
  onSaved: (saved: AssetRecord) => void;
}

export function AssetFormDialog(props: AssetFormDialogProps) {
  // `key` pela versão: depois de um conflito o detalhe recarregado reinicia o formulário.
  return <AssetFormBody key={props.asset ? `${props.asset.id}-${props.asset.version}` : "novo"} {...props} />;
}

function AssetFormBody({
  open,
  onOpenChange,
  asset,
  isAdmin,
  units,
  defaultUnitId,
  conflict,
  onConflict,
  onSaved,
}: AssetFormDialogProps) {
  const editing = !!asset;
  const queryClient = useQueryClient();
  const activeUnits = units?.filter((unit) => unit.active);

  const [unitId, setUnitId] = useState(asset?.unit_id ?? defaultUnitId);
  const [patrimony, setPatrimony] = useState(asset?.patrimony_number ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [notes, setNotes] = useState(asset?.notes ?? "");
  const [roomId, setRoomId] = useState(asset?.room_id ?? "");
  const [personId, setPersonId] = useState(asset?.responsible_person_id ?? "");
  const [registrationDate, setRegistrationDate] = useState(asset?.registration_date ?? "");
  const [ownerUnitId, setOwnerUnitId] = useState(asset?.owner_unit_id ?? "");
  const [located, setLocated] = useState<LocatedStatus>(asset?.located ?? "DESCONHECIDO");
  const [category, setCategory] = useState<AssetCategory | "">(asset?.asset_category ?? "");
  const [techType, setTechType] = useState<TechType | "">(asset?.tech_type ?? "");
  const [opStatus, setOpStatus] = useState<OperationalStatus | "">(asset?.operational_status ?? "");
  const [removeLocation, setRemoveLocation] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const hasNotes = !asset || "notes" in asset;
  const rooms = useUnitRooms(unitId, open, true);
  const people = useUnitPeople(unitId, open, true);

  const changed = {
    patrimony: patrimony.trim().replace(/\s+/g, " ") !== (asset?.patrimony_number ?? ""),
    description: description.trim() !== (asset?.description ?? ""),
    notes: hasNotes && notes.trim() !== (asset?.notes ?? ""),
    room: roomId !== (asset?.room_id ?? ""),
    person: personId !== (asset?.responsible_person_id ?? ""),
    date: registrationDate !== (asset?.registration_date ?? ""),
    owner: ownerUnitId !== (asset?.owner_unit_id ?? ""),
    located: located !== (asset?.located ?? "DESCONHECIDO"),
    location: removeLocation,
    category: editing && category !== (asset?.asset_category ?? ""),
    techType: editing && techType !== (asset?.tech_type ?? ""),
    opStatus: editing && opStatus !== (asset?.operational_status ?? ""),
  };
  const dirty = !editing || Object.values(changed).some(Boolean);

  const mutation = useMutation({
    mutationFn: () => {
      if (!asset) {
        const body: CreateAssetRequest = { unit_id: unitId, patrimony_number: patrimony.trim() };
        if (description.trim()) body.description = description.trim();
        if (hasNotes && notes.trim()) body.notes = notes.trim();
        if (roomId) body.room_id = roomId;
        if (personId) body.responsible_person_id = personId;
        if (registrationDate) body.registration_date = registrationDate;
        if (isAdmin) {
          if (ownerUnitId) body.owner_unit_id = ownerUnitId;
          if (located !== "DESCONHECIDO") body.located = located;
        }
        return createAsset(body);
      }
      const body: UpdateAssetRequest = { version: asset.version };
      if (isAdmin && changed.patrimony) body.patrimony_number = patrimony.trim();
      if (changed.description) body.description = blankToNull(description);
      if (changed.notes) body.notes = blankToNull(notes);
      if (changed.room) body.room_id = roomId || null;
      if (changed.person) body.responsible_person_id = personId || null;
      if (changed.date) body.registration_date = registrationDate || null;
      if (isAdmin && changed.owner) body.owner_unit_id = ownerUnitId || null;
      if (isAdmin && changed.located) body.located = located;
      if (changed.location) body.location_id = null;
      if (changed.category) body.asset_category = category || null;
      if (changed.techType) body.tech_type = techType || null;
      if (changed.opStatus) body.operational_status = opStatus || null;
      return updateAsset(asset.id, body);
    },
    onSuccess: (saved) => {
      toast.success(editing ? "Bem atualizado." : "Bem cadastrado.");
      void queryClient.invalidateQueries({ queryKey: assetsQueryKey });
      onSaved(saved);
      onOpenChange(false);
    },
    onError: (error) => {
      if (isAssetVersionConflict(error)) {
        onConflict();
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || notFound || (editing && !dirty)) return;
    setFormError(null);
    const next: typeof errors = {};
    if (!editing && !unitId) next.unit = "Selecione a unidade.";
    if (!(editing && !isAdmin) && !patrimony.trim()) next.patrimony = "Informe o número patrimonial.";
    setErrors(next);
    const first = next.unit ? "bem-unidade" : next.patrimony ? "bem-numero" : null;
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    mutation.mutate();
  }

  function chooseUnit(value: string) {
    setUnitId(value);
    setRoomId("");
    setPersonId("");
    setErrors((prev) => ({ ...prev, unit: undefined }));
  }

  function chooseCategory(value: AssetCategory | "") {
    setCategory(value);
    if (value !== "TECNOLOGIA") setTechType(""); // tipo de TI só existe em Tecnologia
  }

  const pending = mutation.isPending;
  const roomOptions = withCurrent(rooms.data?.rooms, asset?.room);
  const personOptions = withCurrent(people.data?.people, asset?.responsible_person);

  return (
    <CatalogFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Editar bem" : "Novo bem"}
      description={
        editing
          ? isAdmin
            ? "Altere os dados do bem. A unidade não pode ser trocada por aqui."
            : "Altere descrição, observações, sala, responsável e data de registro. A unidade não pode ser trocada por aqui."
          : "O bem será cadastrado na unidade escolhida. O número patrimonial não pode se repetir entre bens ativos."
      }
      submitLabel={editing ? "Salvar bem" : "Cadastrar bem"}
      pending={pending}
      error={formError}
      submitDisabled={notFound || (editing && !dirty)}
      onSubmit={handleSubmit}
    >
      {conflict ? <FormMessage surface="light">{ASSET_VERSION_CONFLICT_MESSAGE}</FormMessage> : null}
      {notFound ? <FormMessage surface="light">{ASSET_NOT_FOUND_MESSAGE}</FormMessage> : null}

      {asset ? (
        <ReadOnlyField label="Unidade">{unitRefText(asset.unit)}</ReadOnlyField>
      ) : (
        <FormField id="bem-unidade" label="Unidade" required error={errors.unit} surface="light">
          {(field) => (
            <select
              {...field}
              name="unit_id"
              className={selectControlClassName}
              value={unitId}
              disabled={pending || !activeUnits}
              onChange={(event) => chooseUnit(event.target.value)}
            >
              <option value="">Selecione…</option>
              {activeUnits?.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      )}

      {asset && !isAdmin ? (
        <ReadOnlyField label="Número patrimonial">
          <span translate="no" className="font-mono">
            {asset.patrimony_number}
          </span>
        </ReadOnlyField>
      ) : (
        <FormField
          id="bem-numero"
          label="Número patrimonial"
          required
          error={errors.patrimony}
          surface="light"
          hint="Texto: zeros à esquerda são preservados. Até 64 caracteres."
        >
          {(field) => (
            <Input
              {...field}
              name="patrimony_number"
              autoComplete="off"
              spellCheck={false}
              translate="no"
              maxLength={PATRIMONY_MAX}
              className="font-mono"
              value={patrimony}
              disabled={pending}
              onChange={(event) => {
                setPatrimony(event.target.value);
                setErrors((prev) => ({ ...prev, patrimony: undefined }));
              }}
            />
          )}
        </FormField>
      )}

      <FormField id="bem-descricao" label="Descrição" surface="light">
        {(field) => (
          <textarea
            {...field}
            name="description"
            maxLength={TEXT_MAX}
            className={textareaControlClassName}
            value={description}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </FormField>

      {hasNotes ? (
        <FormField id="bem-observacoes" label="Observações" surface="light">
          {(field) => (
            <textarea
              {...field}
              name="notes"
              maxLength={TEXT_MAX}
              className={textareaControlClassName}
              value={notes}
              disabled={pending}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </FormField>
      ) : null}

      <FormField
        id="bem-sala"
        label="Sala"
        surface="light"
        hint={!unitId ? "Escolha a unidade para listar as salas." : rooms.isError ? "Não foi possível carregar as salas." : undefined}
      >
        {(field) => (
          <select
            {...field}
            name="room_id"
            className={selectControlClassName}
            value={roomId}
            disabled={pending || !unitId}
            onChange={(event) => setRoomId(event.target.value)}
          >
            <option value="">Nenhuma</option>
            {roomOptions.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField
        id="bem-responsavel"
        label="Responsável"
        surface="light"
        hint={
          !unitId
            ? "Escolha a unidade para listar os responsáveis."
            : people.isError
              ? "Não foi possível carregar os responsáveis."
              : undefined
        }
      >
        {(field) => (
          <select
            {...field}
            name="responsible_person_id"
            className={selectControlClassName}
            value={personId}
            disabled={pending || !unitId}
            onChange={(event) => setPersonId(event.target.value)}
          >
            <option value="">Nenhum</option>
            {personOptions.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {asset?.location ? (
        <div className="flex flex-col gap-2">
          <ReadOnlyField label="Local">{removeLocation ? "Será removido ao salvar" : asset.location.name}</ReadOnlyField>
          <label className="flex min-h-6 items-start gap-2 text-body-sm text-obsidian-canvas">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-obsidian-canvas"
              checked={removeLocation}
              disabled={pending}
              onChange={(event) => setRemoveLocation(event.target.checked)}
            />
            <span>Remover a localização atual deste bem</span>
          </label>
          {changed.room ? (
            <p className="text-caption text-graphite-mid">
              Ao trocar a sala, o local atual pode deixar de pertencer a ela. Se o salvamento for recusado, marque
              “Remover a localização atual”.
            </p>
          ) : null}
        </div>
      ) : null}

      <FormField id="bem-data" label="Data de registro" surface="light">
        {(field) => (
          <Input
            {...field}
            type="date"
            name="registration_date"
            min="1900-01-01"
            className="[color-scheme:dark]"
            value={registrationDate}
            disabled={pending}
            onChange={(event) => setRegistrationDate(event.target.value)}
          />
        )}
      </FormField>

      {editing ? (
        <>
          <FormField id="bem-categoria" label="Categoria" surface="light">
            {(field) => (
              <select
                {...field}
                name="asset_category"
                className={selectControlClassName}
                value={category}
                disabled={pending}
                onChange={(event) => chooseCategory(event.target.value as AssetCategory | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {CATEGORY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="bem-tipo-ti"
            label="Tipo de TI"
            surface="light"
            hint={category !== "TECNOLOGIA" ? "Disponível só para a categoria Tecnologia." : undefined}
          >
            {(field) => (
              <select
                {...field}
                name="tech_type"
                className={selectControlClassName}
                value={techType}
                disabled={pending || category !== "TECNOLOGIA"}
                onChange={(event) => setTechType(event.target.value as TechType | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {TECH_TYPE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {TECH_TYPE_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField id="bem-situacao" label="Situação operacional" surface="light">
            {(field) => (
              <select
                {...field}
                name="operational_status"
                className={selectControlClassName}
                value={opStatus}
                disabled={pending}
                onChange={(event) => setOpStatus(event.target.value as OperationalStatus | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {OPERATIONAL_STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {OPERATIONAL_STATUS_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </>
      ) : null}

      {isAdmin ? (
        <>
          <FormField id="bem-proprietaria" label="Unidade proprietária" surface="light">
            {(field) => (
              <select
                {...field}
                name="owner_unit_id"
                className={selectControlClassName}
                value={ownerUnitId}
                disabled={pending || !activeUnits}
                onChange={(event) => setOwnerUnitId(event.target.value)}
              >
                <option value="">Nenhuma</option>
                {withCurrentUnit(activeUnits, asset?.owner_unit).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unitLabel(unit)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField id="bem-localizado" label="Localizado" surface="light">
            {(field) => (
              <select
                {...field}
                name="located"
                className={selectControlClassName}
                value={located}
                disabled={pending}
                onChange={(event) => setLocated(event.target.value as LocatedStatus)}
              >
                {LOCATED_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {LOCATED_LABEL[status]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </>
      ) : null}
    </CatalogFormDialog>
  );
}

/** Opções do seletor + o vínculo atual do bem (que pode estar inativo ou fora da página de 100). */
function withCurrent(
  list: readonly { id: string; name: string }[] | undefined,
  current: { id: string; name: string } | null | undefined,
): { id: string; name: string }[] {
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
