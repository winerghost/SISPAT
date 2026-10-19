"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { createMovement, type CreateMovementRequest, type MovementRecord } from "@/lib/movements-api";
import { getAsset, type AssetRecord } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { CatalogFormDialog } from "@/components/features/catalog/catalog-dialogs";
import { ReadOnlyField } from "@/components/features/catalog/catalog-parts";
import { useUnitPeople, useUnitRooms } from "@/components/features/assets/use-asset-lookups";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { AssetPicker } from "./asset-picker";
import {
  blankToUndefined,
  isMovementNotFound,
  isMovementVersionConflict,
  MOVEMENT_NOT_FOUND_MESSAGE,
  MOVEMENT_VERSION_CONFLICT_MESSAGE,
  movementErrorMessage,
  movementsQueryKey,
  REASON_MAX,
  unitRefText,
} from "./movement-labels";

// =============================================================================
// Solicitar movimentação (`POST /api/v1/movements`), ADM e USER. Escolhe o bem
// (busca em /assets), a unidade de destino (/units/accessible), a sala de
// destino (/rooms da unidade) e o responsável (/responsible-people da unidade).
//
// Semântica de sala/responsável (decidida pelo BACKEND; a tela só a explica):
//   - OUTRA unidade: campo não enviado = o bem ficará SEM sala/responsável.
//   - MESMA unidade: campo não enviado = MANTÉM o atual; `null` = REMOVE.
// A solicitação NÃO altera o bem: ele só muda se um administrador aprovar.
// Envia `asset_version` (controle otimista). Sucesso só após a resposta.
// =============================================================================

const CLEAR = "__limpar__";

type FieldKey = "asset" | "unit";

export function MovementRequestDialog({
  open,
  onOpenChange,
  units,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  units: AccessibleUnit[] | undefined;
  onCreated: (movement: MovementRecord) => void;
}) {
  const queryClient = useQueryClient();
  const activeUnits = units?.filter((unit) => unit.active);

  const [asset, setAsset] = useState<AssetRecord | null>(null);
  const [unitId, setUnitId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [personId, setPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const rooms = useUnitRooms(unitId, open, true);
  const people = useUnitPeople(unitId, open, true);

  const sameUnit = !!asset && unitId !== "" && unitId === asset.unit_id;
  // Resultado que o formulário pede, comparado ao estado atual do bem (só dica de UX).
  const nextRoom = !sameUnit ? (roomId && roomId !== CLEAR ? roomId : null) : roomId === "" ? asset?.room_id : roomId === CLEAR ? null : roomId;
  const nextPerson = !sameUnit
    ? personId && personId !== CLEAR
      ? personId
      : null
    : personId === ""
      ? asset?.responsible_person_id
      : personId === CLEAR
        ? null
        : personId;
  const noChange = sameUnit && (nextRoom ?? null) === (asset?.room_id ?? null) && (nextPerson ?? null) === (asset?.responsible_person_id ?? null);

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateMovementRequest = {
        asset_id: asset!.id,
        asset_version: asset!.version,
        destination_unit_id: unitId,
      };
      // Ausente = regra do servidor (vazio em outra unidade; mantém na mesma); null = limpa (só na mesma).
      if (roomId === CLEAR) body.destination_room_id = null;
      else if (roomId) body.destination_room_id = roomId;
      if (personId === CLEAR) body.new_responsible_id = null;
      else if (personId) body.new_responsible_id = personId;
      const text = blankToUndefined(reason);
      if (text) body.reason = text;
      return createMovement(body);
    },
    onSuccess: (saved) => {
      toast.success("Solicitação registrada. O bem só será alterado se um administrador aprovar.");
      void queryClient.invalidateQueries({ queryKey: movementsQueryKey });
      onCreated(saved);
      onOpenChange(false);
    },
    onError: async (error) => {
      if (isMovementVersionConflict(error) && asset) {
        // Recarrega o bem (nova `version`) e pede revisão; nada é reenviado sozinho.
        try {
          setAsset(await getAsset(asset.id));
          setFormError(MOVEMENT_VERSION_CONFLICT_MESSAGE);
        } catch (reloadError) {
          setAsset(null);
          setFormError(isMovementNotFound(reloadError) ? MOVEMENT_NOT_FOUND_MESSAGE : MOVEMENT_VERSION_CONFLICT_MESSAGE);
        }
        return;
      }
      setFormError(movementErrorMessage(error, "Não foi possível registrar a solicitação agora. Tente novamente."));
    },
  });

  function chooseAsset(next: AssetRecord | null) {
    setAsset(next);
    setUnitId("");
    setRoomId("");
    setPersonId("");
    setFormError(null);
    setErrors((prev) => ({ ...prev, asset: undefined }));
  }

  function chooseUnit(value: string) {
    setUnitId(value);
    setRoomId("");
    setPersonId("");
    setFormError(null);
    setErrors((prev) => ({ ...prev, unit: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    setFormError(null);
    const next: typeof errors = {};
    if (!asset) next.asset = "Escolha o bem a movimentar.";
    if (!unitId) next.unit = "Escolha a unidade de destino.";
    setErrors(next);
    if (next.asset) {
      document.getElementById("mov-bem-busca")?.focus();
      return;
    }
    if (next.unit) {
      document.getElementById("mov-unidade")?.focus();
      return;
    }
    if (noChange) return;
    mutation.mutate();
  }

  const pending = mutation.isPending;
  const roomHint = !unitId
    ? "Escolha a unidade de destino para listar as salas."
    : rooms.isError
      ? "Não foi possível carregar as salas."
      : sameUnit
        ? "Mesma unidade do bem: “Manter a sala atual” não altera a sala; “Remover a sala” a deixa vazia."
        : "Outra unidade: sem escolher uma sala, o bem ficará SEM sala no destino.";
  const personHint = !unitId
    ? "Escolha a unidade de destino para listar os responsáveis."
    : people.isError
      ? "Não foi possível carregar os responsáveis."
      : sameUnit
        ? "Mesma unidade do bem: “Manter o responsável atual” não o altera; “Remover o responsável” o deixa vazio."
        : "Outra unidade: sem escolher um responsável, o bem ficará SEM responsável no destino.";

  return (
    <CatalogFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Solicitar movimentação"
      description="A solicitação fica PENDENTE e não altera o bem. Somente um administrador pode aprová-la; depois de aprovada, o histórico é imutável."
      submitLabel="Solicitar movimentação"
      pendingLabel="Enviando…"
      pending={pending}
      error={formError}
      submitDisabled={noChange}
      onSubmit={handleSubmit}
    >
      <AssetPicker
        idPrefix="mov-bem"
        label="Bem"
        clearLabel="Trocar bem"
        surface="light"
        required
        value={asset}
        error={errors.asset}
        disabled={pending}
        onChange={chooseAsset}
      />

      {asset ? (
        <ReadOnlyField label="Situação atual do bem">
          {unitRefText(asset.unit)} · {asset.room?.name ?? "sem sala"} · {asset.responsible_person?.name ?? "sem responsável"}
        </ReadOnlyField>
      ) : null}

      <FormField id="mov-unidade" label="Unidade de destino" required error={errors.unit} surface="light">
        {(field) => (
          <select
            {...field}
            name="destination_unit_id"
            className={selectControlClassName}
            value={unitId}
            disabled={pending || !asset || !activeUnits}
            onChange={(event) => chooseUnit(event.target.value)}
          >
            <option value="">{asset ? "Selecione…" : "Escolha o bem primeiro"}</option>
            {activeUnits?.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unitLabel(unit)}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField id="mov-sala" label="Sala de destino" surface="light" hint={roomHint}>
        {(field) => (
          <select
            {...field}
            name="destination_room_id"
            className={selectControlClassName}
            value={roomId}
            disabled={pending || !unitId}
            onChange={(event) => setRoomId(event.target.value)}
          >
            <option value="">{sameUnit ? "Manter a sala atual" : "Sem sala no destino"}</option>
            {sameUnit ? <option value={CLEAR}>Remover a sala (deixar vazia)</option> : null}
            {rooms.data?.rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField id="mov-responsavel" label="Novo responsável" surface="light" hint={personHint}>
        {(field) => (
          <select
            {...field}
            name="new_responsible_id"
            className={selectControlClassName}
            value={personId}
            disabled={pending || !unitId}
            onChange={(event) => setPersonId(event.target.value)}
          >
            <option value="">{sameUnit ? "Manter o responsável atual" : "Sem responsável no destino"}</option>
            {sameUnit ? <option value={CLEAR}>Remover o responsável (deixar vazio)</option> : null}
            {people.data?.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {noChange ? (
        <FormMessage surface="light">
          Nada mudaria no bem: escolha outra sala ou outro responsável, ou uma unidade de destino diferente.
        </FormMessage>
      ) : null}

      <FormField id="mov-motivo" label="Motivo (opcional)" surface="light" hint="Até 500 caracteres.">
        {(field) => (
          <textarea
            {...field}
            name="reason"
            maxLength={REASON_MAX}
            className={textareaControlClassName}
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </FormField>
    </CatalogFormDialog>
  );
}
