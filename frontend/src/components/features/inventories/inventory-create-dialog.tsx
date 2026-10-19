"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { createInventory, type CreateInventoryRequest, type InventoryRecord } from "@/lib/inventories-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { CatalogFormDialog } from "@/components/features/catalog/catalog-dialogs";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { blankToUndefined, inventoriesQueryKey, inventoryErrorMessage, NAME_MAX } from "./inventory-labels";

// =============================================================================
// Criar inventário (`POST /api/v1/inventories`), SÓ ADM (+AAL2; o backend decide).
// Uma campanha de conferência é POR UNIDADE: nome (1..200), unidade ativa e data
// de início opcional (padrão do servidor: hoje, UTC). Nasce ABERTO — só passa a
// aceitar conferências depois de iniciado. Nome, unidade e início NÃO podem ser
// editados depois. Sucesso só após a resposta; erros com texto fixo.
// =============================================================================

type FieldKey = "name" | "unit";

export function InventoryCreateDialog({
  open,
  onOpenChange,
  units,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  units: AccessibleUnit[] | undefined;
  onCreated: (inventory: InventoryRecord) => void;
}) {
  const queryClient = useQueryClient();
  const activeUnits = units?.filter((unit) => unit.active);
  const [name, setName] = useState("");
  const [unitId, setUnitId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateInventoryRequest = { name: name.trim(), unit_id: unitId };
      const date = blankToUndefined(startDate);
      if (date) body.start_date = date;
      return createInventory(body);
    },
    onSuccess: (saved) => {
      toast.success("Inventário criado. Ele só aceita conferências depois de iniciado.");
      void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
      onCreated(saved);
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(inventoryErrorMessage(error, "Não foi possível criar o inventário agora. Tente novamente."));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    setFormError(null);
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Informe o nome do inventário.";
    if (!unitId) next.unit = "Escolha a unidade do inventário.";
    setErrors(next);
    if (next.name) {
      document.getElementById("inv-nome")?.focus();
      return;
    }
    if (next.unit) {
      document.getElementById("inv-unidade")?.focus();
      return;
    }
    mutation.mutate();
  }

  const pending = mutation.isPending;
  return (
    <CatalogFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Novo inventário"
      description="Cria uma campanha de conferência física dos bens de UMA unidade. Ela nasce ABERTA e só aceita conferências depois de iniciada. Nome, unidade e data de início não podem ser editados depois."
      submitLabel="Criar inventário"
      pendingLabel="Criando…"
      pending={pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <FormField id="inv-nome" label="Nome" required error={errors.name} surface="light" hint="Até 200 caracteres.">
        {(field) => (
          <Input
            {...field}
            name="name"
            maxLength={NAME_MAX}
            autoComplete="off"
            value={name}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
              setErrors((prev) => ({ ...prev, name: undefined }));
            }}
          />
        )}
      </FormField>

      <FormField id="inv-unidade" label="Unidade" required error={errors.unit} surface="light">
        {(field) => (
          <select
            {...field}
            name="unit_id"
            className={selectControlClassName}
            value={unitId}
            disabled={pending || !activeUnits}
            onChange={(event) => {
              setUnitId(event.target.value);
              setErrors((prev) => ({ ...prev, unit: undefined }));
            }}
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

      <FormField
        id="inv-inicio"
        label="Data de início (opcional)"
        surface="light"
        hint="Se vazia, o servidor usa a data de hoje."
      >
        {(field) => (
          <Input
            {...field}
            type="date"
            name="start_date"
            min="2000-01-01"
            className="[color-scheme:dark]"
            value={startDate}
            disabled={pending}
            onChange={(event) => setStartDate(event.target.value)}
          />
        )}
      </FormField>
    </CatalogFormDialog>
  );
}
