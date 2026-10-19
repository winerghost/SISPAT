"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FormField, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import {
  getUnit,
  setUnitActive,
  updateUnit,
  type UnitCatalogItem,
  type UnitRecord,
  type UpdateUnitRequest,
} from "@/lib/catalog-api";
import { UNITS_QUERY_KEY } from "@/components/features/users/unit-checkbox-list";
import { CatalogFormDialog } from "./catalog-dialogs";
import { blankToNull, catalogErrorMessage, isCatalogVersionConflict, VERSION_CONFLICT_MESSAGE } from "./catalog-labels";
import { ActiveBadge, ReadOnlyField } from "./catalog-parts";
import { useActiveToggle } from "./use-active-toggle";
import { useCatalogRecord } from "./use-catalog-record";

// =============================================================================
// Unidade — editar (PATCH /units/<id>) e inativar/reativar. Não há criação.
// - `code` (sigla) e `source_record_id` são imutáveis: aparecem só como leitura.
// - `address` só existe para ADM: o campo só aparece se a chave veio.
// - A listagem (`GET /units/catalog`) traz ativas e inativas; o detalhe
//   (`GET /units/<id>`) traz a descrição e o `updated_at` usado como
//   pré-condição de concorrência.
// =============================================================================

export const unitDetailKey = (id: string) => ["catalog", "units", "detail", id] as const;

export interface UnitFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: UnitCatalogItem | null;
}

/** Esboço enquanto `GET /units/<id>` não responde (nenhum campo editável é usado). */
function sketch(unit: UnitCatalogItem): UnitRecord {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    description: null,
    active: unit.active,
    source_record_id: unit.source_record_id,
    created_at: null,
    updated_at: unit.updated_at,
  };
}

export function UnitFormDialog({ open, onOpenChange, unit }: UnitFormDialogProps) {
  const state = useCatalogRecord<UnitRecord>({
    open,
    row: unit ? sketch(unit) : null,
    queryKey: unitDetailKey(unit?.id ?? ""),
    fetchRecord: () => getUnit(unit!.id),
    noun: "unidade",
  });
  return (
    <UnitFormBody
      key={state.placeholder ? "carregando" : (state.record?.updated_at ?? "sem-versao")}
      open={open}
      onOpenChange={onOpenChange}
      record={state.record}
      placeholder={state.placeholder}
      notFound={state.notFound}
      loadError={state.loadError}
      conflict={state.conflict}
      onConflict={state.onConflict}
    />
  );
}

function UnitFormBody({
  open,
  onOpenChange,
  record,
  placeholder,
  notFound,
  loadError,
  conflict,
  onConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: UnitRecord | null;
  placeholder: boolean;
  notFound: boolean;
  loadError: string | null;
  conflict: boolean;
  onConflict: () => void;
}) {
  const queryClient = useQueryClient();
  const hasAddress = record !== null && "address" in record;
  const [name, setName] = useState(record?.name ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [address, setAddress] = useState(record?.address ?? "");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const ready = record !== null && !placeholder && !notFound;
  const dirty =
    ready &&
    (name.trim() !== record.name ||
      description.trim() !== (record.description ?? "") ||
      (hasAddress && address.trim() !== (record.address ?? "")));

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: UNITS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["catalog"] });
  }

  const mutation = useMutation({
    mutationFn: () => {
      const current = record!;
      const body: UpdateUnitRequest = { expected_updated_at: current.updated_at ?? undefined };
      if (name.trim() !== current.name) body.name = name.trim();
      if (description.trim() !== (current.description ?? "")) body.description = blankToNull(description);
      if (hasAddress && address.trim() !== (current.address ?? "")) body.address = blankToNull(address);
      return updateUnit(current.id, body);
    },
    onSuccess: () => {
      toast.success("Unidade atualizada.");
      refresh();
      onOpenChange(false);
    },
    onError: (error) => {
      if (isCatalogVersionConflict(error)) {
        onConflict();
        refresh();
        return;
      }
      setFormError(catalogErrorMessage(error, "unidade", "Não foi possível salvar a unidade agora. Tente novamente."));
    },
  });

  const toggle = useActiveToggle<UnitRecord>({
    noun: "unidade",
    request: setUnitActive,
    onDone: () => {
      refresh();
      onOpenChange(false);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !dirty) return;
    setFormError(null);
    if (!name.trim()) {
      setNameError("Informe o nome da unidade.");
      document.getElementById("unidade-nome")?.focus();
      return;
    }
    mutation.mutate();
  }

  const pending = mutation.isPending;
  return (
    <>
      <CatalogFormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Editar unidade"
        description="Altere nome, descrição e endereço. A sigla e o ID de origem são imutáveis."
        submitLabel="Salvar unidade"
        pending={pending}
        error={formError ?? loadError}
        submitDisabled={!dirty}
        onSubmit={handleSubmit}
      >
        {conflict ? <FormMessage surface="light">{VERSION_CONFLICT_MESSAGE}</FormMessage> : null}
        {notFound ? (
          <FormMessage surface="light">Registro não encontrado, ou fora do seu escopo de unidades.</FormMessage>
        ) : !ready || !record ? (
          <LoadingSkeleton variant="lines" count={4} label="Carregando unidade…" />
        ) : (
          <>
            <ReadOnlyField label="Sigla">{record.code}</ReadOnlyField>
            {record.source_record_id ? (
              <ReadOnlyField label="ID de origem (planilha)">{record.source_record_id}</ReadOnlyField>
            ) : null}

            <FormField id="unidade-nome" label="Nome" required error={nameError} surface="light">
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
                    setNameError(undefined);
                  }}
                />
              )}
            </FormField>

            <FormField id="unidade-descricao" label="Descrição" surface="light">
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

            {hasAddress ? (
              <FormField id="unidade-endereco" label="Endereço" surface="light">
                {(field) => (
                  <textarea
                    {...field}
                    name="address"
                    maxLength={500}
                    className={textareaControlClassName}
                    value={address}
                    disabled={pending}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                )}
              </FormField>
            ) : null}

            <div className="flex flex-col gap-2 border-t border-graphite-mid/30 pt-4">
              <span className="text-eyebrow text-graphite-mid">Situação</span>
              <div className="flex flex-wrap items-center gap-3">
                <ActiveBadge active={record.active} surface="light" />
                <Button
                  type="button"
                  variant="outlineOnLight"
                  size="sm"
                  disabled={pending}
                  onClick={() => toggle.ask(record)}
                >
                  {record.active ? "Inativar unidade" : "Reativar unidade"}
                </Button>
              </div>
              <p className="text-caption text-graphite-mid">
                Não há exclusão: inativar preserva o registro e pode ser desfeito.
              </p>
            </div>
          </>
        )}
      </CatalogFormDialog>
      {toggle.dialog}
    </>
  );
}
