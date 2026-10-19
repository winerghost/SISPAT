"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import {
  createRoom,
  getRoom,
  updateRoom,
  type CreateRoomRequest,
  type RoomRecord,
  type UpdateRoomRequest,
} from "@/lib/catalog-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import type { UnitRef } from "@/lib/users-api";
import { CatalogFormDialog } from "./catalog-dialogs";
import {
  blankToNull,
  catalogErrorMessage,
  isCatalogVersionConflict,
  VERSION_CONFLICT_MESSAGE,
} from "./catalog-labels";
import { ReadOnlyField, unitText } from "./catalog-parts";
import { useCatalogRecord } from "./use-catalog-record";

// =============================================================================
// Sala — criar (POST /rooms) e editar (PATCH /rooms/<id>).
// Edição NÃO troca a unidade (campo somente leitura); só vão no PATCH os campos
// alterados, com `expected_updated_at`. Limites (nome 200, descrição 1000,
// andar 50) são `maxLength` de UX — o backend valida de fato.
// =============================================================================

export const roomsQueryKey = ["catalog", "rooms"] as const;
export const roomDetailKey = (id: string) => [...roomsQueryKey, "detail", id] as const;

export interface RoomFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = criar. */
  room: RoomRecord | null;
  units: UnitRef[] | undefined;
  /** Unidade pré-selecionada na criação (filtro atual da lista). */
  defaultUnitId: string;
}

export function RoomFormDialog({ open, onOpenChange, room, units, defaultUnitId }: RoomFormDialogProps) {
  const state = useCatalogRecord<RoomRecord>({
    open,
    row: room,
    queryKey: roomDetailKey(room?.id ?? ""),
    fetchRecord: () => getRoom(room!.id),
    noun: "sala",
  });
  return (
    <RoomFormBody
      key={state.record?.updated_at ?? "nova"}
      open={open}
      onOpenChange={onOpenChange}
      record={state.record}
      editing={!!room}
      units={units}
      defaultUnitId={defaultUnitId}
      notFound={state.notFound}
      loadError={state.loadError}
      conflict={state.conflict}
      onConflict={state.onConflict}
    />
  );
}

function RoomFormBody({
  open,
  onOpenChange,
  record,
  editing,
  units,
  defaultUnitId,
  notFound,
  loadError,
  conflict,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: RoomRecord | null;
  editing: boolean;
  units: UnitRef[] | undefined;
  defaultUnitId: string;
  notFound: boolean;
  loadError: string | null;
  conflict: boolean;
  onConflict: () => void;
}) {
  const queryClient = useQueryClient();
  const [unitId, setUnitId] = useState(defaultUnitId);
  const [name, setName] = useState(record?.name ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [floor, setFloor] = useState(record?.floor ?? "");
  const [errors, setErrors] = useState<Partial<Record<"unit" | "name", string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = editing
    ? name.trim() !== (record?.name ?? "") ||
      description.trim() !== (record?.description ?? "") ||
      floor.trim() !== (record?.floor ?? "")
    : true;

  const mutation = useMutation({
    mutationFn: () => {
      if (!editing || !record) {
        const body: CreateRoomRequest = { unit_id: unitId, name: name.trim() };
        if (description.trim()) body.description = description.trim();
        if (floor.trim()) body.floor = floor.trim();
        return createRoom(body);
      }
      const body: UpdateRoomRequest = { expected_updated_at: record.updated_at ?? undefined };
      if (name.trim() !== record.name) body.name = name.trim();
      if (description.trim() !== (record.description ?? "")) body.description = blankToNull(description);
      if (floor.trim() !== (record.floor ?? "")) body.floor = blankToNull(floor);
      return updateRoom(record.id, body);
    },
    onSuccess: () => {
      toast.success(editing ? "Sala atualizada." : "Sala criada.");
      void queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      if (isCatalogVersionConflict(error)) {
        onConflict();
        void queryClient.invalidateQueries({ queryKey: roomsQueryKey });
        return;
      }
      setFormError(catalogErrorMessage(error, "sala", "Não foi possível salvar a sala agora. Tente novamente."));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || notFound || (editing && !dirty)) return;
    setFormError(null);
    const next: typeof errors = {};
    if (!editing && !unitId) next.unit = "Selecione a unidade.";
    if (!name.trim()) next.name = "Informe o nome da sala.";
    setErrors(next);
    const first = next.unit ? "sala-unidade" : next.name ? "sala-nome" : null;
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    mutation.mutate();
  }

  const pending = mutation.isPending;
  return (
    <CatalogFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Editar sala" : "Nova sala"}
      description={
        editing
          ? "Altere nome, descrição e andar. A unidade não pode ser trocada por aqui."
          : "A sala será criada na unidade escolhida. Nome repetido na mesma unidade é recusado."
      }
      submitLabel={editing ? "Salvar sala" : "Criar sala"}
      pending={pending}
      error={formError ?? loadError}
      submitDisabled={notFound || (editing && !dirty)}
      onSubmit={handleSubmit}
    >
      {conflict ? <FormMessage surface="light">{VERSION_CONFLICT_MESSAGE}</FormMessage> : null}
      {notFound ? (
        <FormMessage surface="light">Registro não encontrado, ou fora do seu escopo de unidades.</FormMessage>
      ) : (
        <>
          {editing && record ? (
            <>
              <ReadOnlyField label="Unidade">{unitText(record.unit_id, units)}</ReadOnlyField>
              {record.source_record_id ? (
                <ReadOnlyField label="ID de origem (planilha)">{record.source_record_id}</ReadOnlyField>
              ) : null}
            </>
          ) : (
            <FormField id="sala-unidade" label="Unidade" required error={errors.unit} surface="light">
              {(field) => (
                <select
                  {...field}
                  name="unit_id"
                  className={selectControlClassName}
                  value={unitId}
                  disabled={pending || !units}
                  onChange={(event) => {
                    setUnitId(event.target.value);
                    setErrors((prev) => ({ ...prev, unit: undefined }));
                  }}
                >
                  <option value="">Selecione…</option>
                  {units?.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unitLabel(unit)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          )}

          <FormField id="sala-nome" label="Nome" required error={errors.name} surface="light">
            {(field) => (
              <Input
                {...field}
                name="name"
                autoComplete="off"
                maxLength={200}
                value={name}
                disabled={pending}
                onChange={(event) => {
                  setName(event.target.value);
                  setErrors((prev) => ({ ...prev, name: undefined }));
                }}
              />
            )}
          </FormField>

          <FormField id="sala-andar" label="Andar" surface="light">
            {(field) => (
              <Input
                {...field}
                name="floor"
                autoComplete="off"
                maxLength={50}
                value={floor}
                disabled={pending}
                onChange={(event) => setFloor(event.target.value)}
              />
            )}
          </FormField>

          <FormField id="sala-descricao" label="Descrição" surface="light">
            {(field) => (
              <textarea
                {...field}
                name="description"
                maxLength={1000}
                className={textareaControlClassName}
                value={description}
                disabled={pending}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </FormField>
        </>
      )}
    </CatalogFormDialog>
  );
}
