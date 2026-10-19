"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import type { AssetRecord } from "@/lib/assets-api";
import {
  checkInventoryItem,
  type CheckInventoryItemRequest,
  type InventoryItemRecord,
  type InventoryRecord,
} from "@/lib/inventories-api";
import { CatalogFormDialog } from "@/components/features/catalog/catalog-dialogs";
import { ReadOnlyField } from "@/components/features/catalog/catalog-parts";
import {
  blankToUndefined,
  inventoriesQueryKey,
  inventoryErrorMessage,
  isAlreadyChecked,
  isInventoryNotFound,
  isStaleConflict,
  NOTES_MAX,
  NO_LOCATED_UPDATE_NOTE,
  resultLabel,
} from "./inventory-labels";
import { useUnitLocations } from "./use-inventory-data";

// =============================================================================
// Conferir bem (`POST /api/v1/inventories/<id>/items`), ADM e USER (permissão
// `inventory.check`; o backend decide). Envia `{asset_id, found,
// observed_location_id?, notes?}`. O RESULTADO (Encontrado / Não encontrado /
// Divergente), o conferidor e a data são calculados pelo SERVIDOR: a tela só os
// explica e exibe o que ele devolveu. A conferência é única por bem e imutável
// (409 `already_checked`: sem reconferência) e NÃO altera o bem (`located` e o
// local cadastrado permanecem). As notas são texto livre (nunca HTML).
// =============================================================================

type Found = "" | "yes" | "no";

export function InventoryCheckDialog({
  open,
  onOpenChange,
  inventory,
  asset,
  onChecked,
  onStale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventory: InventoryRecord;
  asset: AssetRecord;
  onChecked: (item: InventoryItemRecord) => void;
  /** O estado do inventário mudou (encerrado, cancelado ou ainda não iniciado). */
  onStale: () => void;
}) {
  const queryClient = useQueryClient();
  const [found, setFound] = useState<Found>("");
  const [locationId, setLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [foundError, setFoundError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const locations = useUnitLocations(inventory.unit_id, open);

  useEffect(() => {
    if (!open) {
      setFound("");
      setLocationId("");
      setNotes("");
      setFoundError(null);
      setFormError(null);
    }
  }, [open]);

  const activeLocations = locations.data?.locations.filter((location) => location.active) ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      const body: CheckInventoryItemRequest = { asset_id: asset.id, found: found === "yes" };
      if (found === "yes" && locationId) body.observed_location_id = locationId;
      const text = blankToUndefined(notes);
      if (text) body.notes = text;
      return checkInventoryItem(inventory.id, body);
    },
    onSuccess: (saved) => {
      toast.success(`Conferência registrada: ${resultLabel(saved.result)}. O bem não foi alterado.`);
      void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
      onChecked(saved);
      onOpenChange(false);
    },
    onError: (error) => {
      if (isStaleConflict(error)) {
        toast.error(inventoryErrorMessage(error, "Não foi possível registrar a conferência."));
        void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
        onOpenChange(false);
        onStale();
        return;
      }
      if (isAlreadyChecked(error) || isInventoryNotFound(error)) {
        void queryClient.invalidateQueries({ queryKey: inventoriesQueryKey });
      }
      setFormError(inventoryErrorMessage(error, "Não foi possível registrar a conferência agora. Tente novamente."));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    setFormError(null);
    if (found === "") {
      setFoundError("Informe se o bem foi encontrado.");
      document.getElementById("inv-conf-sim")?.focus();
      return;
    }
    setFoundError(null);
    mutation.mutate();
  }

  const pending = mutation.isPending;
  const registered = asset.location?.name;
  const locationHint = found !== "yes"
    ? "Disponível quando o bem é encontrado."
    : locations.isError
      ? "Não foi possível carregar os locais. É possível conferir sem informar o local."
      : registered
        ? `Local cadastrado do bem: ${registered}. Um local diferente é registrado pelo servidor como DIVERGENTE.`
        : "O bem não tem local cadastrado. Informar um local é opcional.";

  return (
    <CatalogFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Conferir bem"
      description="Registra a conferência física deste bem no inventário. Ela é única e imutável: não é possível editar, excluir nem reconferir."
      submitLabel="Registrar conferência"
      pendingLabel="Registrando…"
      pending={pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <ReadOnlyField label="Bem">
        <span translate="no" className="font-mono">
          {asset.patrimony_number}
        </span>
        {asset.description ? ` — ${asset.description}` : ""}
      </ReadOnlyField>

      <fieldset
        className="flex min-w-0 flex-col gap-1.5"
        aria-describedby={foundError ? "inv-conf-encontrado-erro" : undefined}
      >
        <legend className="mb-1.5 text-eyebrow text-graphite-mid">
          O bem foi encontrado?
          <span aria-hidden="true" className="ml-1">
            *
          </span>
        </legend>
        <label className="flex min-h-8 items-center gap-2 text-body-sm text-obsidian-canvas">
          <input
            id="inv-conf-sim"
            type="radio"
            name="found"
            value="yes"
            required
            className="h-4 w-4 accent-obsidian-canvas"
            checked={found === "yes"}
            disabled={pending}
            onChange={() => {
              setFound("yes");
              setFoundError(null);
            }}
          />
          Sim, foi encontrado
        </label>
        <label className="flex min-h-8 items-center gap-2 text-body-sm text-obsidian-canvas">
          <input
            id="inv-conf-nao"
            type="radio"
            name="found"
            value="no"
            className="h-4 w-4 accent-obsidian-canvas"
            checked={found === "no"}
            disabled={pending}
            onChange={() => {
              setFound("no");
              setLocationId("");
              setFoundError(null);
            }}
          />
          Não, não foi encontrado
        </label>
        {foundError ? (
          <FormMessage id="inv-conf-encontrado-erro" surface="light">
            {foundError}
          </FormMessage>
        ) : null}
      </fieldset>

      <FormField id="inv-conf-local" label="Local observado (opcional)" surface="light" hint={locationHint}>
        {(field) => (
          <select
            {...field}
            name="observed_location_id"
            className={selectControlClassName}
            value={locationId}
            disabled={pending || found !== "yes"}
            onChange={(event) => setLocationId(event.target.value)}
          >
            <option value="">Sem local informado</option>
            {activeLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        )}
      </FormField>

      <FormField id="inv-conf-notas" label="Observações (opcional)" surface="light" hint="Texto livre, até 500 caracteres.">
        {(field) => (
          <textarea
            {...field}
            name="notes"
            maxLength={NOTES_MAX}
            className={textareaControlClassName}
            value={notes}
            disabled={pending}
            onChange={(event) => setNotes(event.target.value)}
          />
        )}
      </FormField>

      <p className="text-caption text-graphite-mid">
        O resultado, o conferidor e a data são definidos pelo servidor. {NO_LOCATED_UPDATE_NOTE}
      </p>
    </CatalogFormDialog>
  );
}
