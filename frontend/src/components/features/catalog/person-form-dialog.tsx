"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import {
  createPerson,
  getPerson,
  updatePerson,
  type CreatePersonRequest,
  type PersonRecord,
  type UpdatePersonRequest,
} from "@/lib/catalog-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import type { UnitRef } from "@/lib/users-api";
import { CatalogFormDialog } from "./catalog-dialogs";
import {
  blankToNull,
  catalogErrorMessage,
  formatPhone,
  isCatalogVersionConflict,
  samePhone,
  VERSION_CONFLICT_MESSAGE,
} from "./catalog-labels";
import { ReadOnlyField, unitText } from "./catalog-parts";
import { useCatalogRecord } from "./use-catalog-record";

// =============================================================================
// Pessoa responsável — criar (POST /responsible-people) e editar (PATCH).
// - Telefone é dado pessoal (LGPD): o campo só aparece se a chave `phone` veio
//   do backend (edição) ou na criação (rota exclusiva do ADM). O valor nunca é
//   logado nem vai para URL/storage; a lista exibe só máscara.
// - Edição NÃO troca a unidade; só vão no PATCH os campos alterados, com
//   `expected_updated_at`. Formato de e-mail/telefone é validado no backend.
// =============================================================================

export const peopleQueryKey = ["catalog", "people"] as const;
export const personDetailKey = (id: string) => [...peopleQueryKey, "detail", id] as const;

export interface PersonFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` = criar. */
  person: PersonRecord | null;
  units: UnitRef[] | undefined;
  defaultUnitId: string;
}

export function PersonFormDialog({ open, onOpenChange, person, units, defaultUnitId }: PersonFormDialogProps) {
  const state = useCatalogRecord<PersonRecord>({
    open,
    row: person,
    queryKey: personDetailKey(person?.id ?? ""),
    fetchRecord: () => getPerson(person!.id),
    noun: "pessoa responsável",
  });
  return (
    <PersonFormBody
      key={state.record?.updated_at ?? "nova"}
      open={open}
      onOpenChange={onOpenChange}
      record={state.record}
      editing={!!person}
      units={units}
      defaultUnitId={defaultUnitId}
      notFound={state.notFound}
      loadError={state.loadError}
      conflict={state.conflict}
      onConflict={state.onConflict}
    />
  );
}

type FieldKey = "unit" | "name" | "email";

function PersonFormBody({
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
  record: PersonRecord | null;
  editing: boolean;
  units: UnitRef[] | undefined;
  defaultUnitId: string;
  notFound: boolean;
  loadError: string | null;
  conflict: boolean;
  onConflict: () => void;
}) {
  const queryClient = useQueryClient();
  // Criação é exclusiva do ADM => o telefone existe; na edição, só se a chave veio.
  const hasPhone = !editing || (record !== null && "phone" in record);
  const [unitId, setUnitId] = useState(defaultUnitId);
  const [name, setName] = useState(record?.name ?? "");
  const [email, setEmail] = useState(record?.email ?? "");
  const [phone, setPhone] = useState(formatPhone(record?.phone));
  const [identifier, setIdentifier] = useState(record?.institutional_identifier ?? "");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const phoneChanged = hasPhone && !samePhone(phone, record?.phone);
  const dirty = editing
    ? name.trim() !== (record?.name ?? "") ||
      email.trim() !== (record?.email ?? "") ||
      identifier.trim() !== (record?.institutional_identifier ?? "") ||
      phoneChanged
    : true;

  const mutation = useMutation({
    mutationFn: () => {
      if (!editing || !record) {
        const body: CreatePersonRequest = { unit_id: unitId, name: name.trim() };
        if (email.trim()) body.email = email.trim();
        if (phone.trim()) body.phone = phone.trim();
        if (identifier.trim()) body.institutional_identifier = identifier.trim();
        return createPerson(body);
      }
      const body: UpdatePersonRequest = { expected_updated_at: record.updated_at ?? undefined };
      if (name.trim() !== record.name) body.name = name.trim();
      if (email.trim() !== (record.email ?? "")) body.email = blankToNull(email);
      if (phoneChanged) body.phone = blankToNull(phone);
      if (identifier.trim() !== (record.institutional_identifier ?? "")) {
        body.institutional_identifier = blankToNull(identifier);
      }
      return updatePerson(record.id, body);
    },
    onSuccess: () => {
      toast.success(editing ? "Pessoa responsável atualizada." : "Pessoa responsável criada.");
      void queryClient.invalidateQueries({ queryKey: peopleQueryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      if (isCatalogVersionConflict(error)) {
        onConflict();
        void queryClient.invalidateQueries({ queryKey: peopleQueryKey });
        return;
      }
      setFormError(
        catalogErrorMessage(error, "pessoa responsável", "Não foi possível salvar agora. Tente novamente."),
      );
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || notFound || (editing && !dirty)) return;
    setFormError(null);
    const emailInput = event.currentTarget.elements.namedItem("email") as HTMLInputElement | null;
    const next: typeof errors = {};
    if (!editing && !unitId) next.unit = "Selecione a unidade.";
    if (!name.trim()) next.name = "Informe o nome.";
    if (email.trim() && emailInput?.validity.typeMismatch) next.email = "Informe um e-mail válido.";
    setErrors(next);
    const first = next.unit ? "pessoa-unidade" : next.name ? "pessoa-nome" : next.email ? "pessoa-email" : null;
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
      title={editing ? "Editar pessoa responsável" : "Nova pessoa responsável"}
      description={
        editing
          ? "Altere os dados cadastrais. A unidade não pode ser trocada por aqui."
          : "A pessoa será criada na unidade escolhida. E-mail e identificador institucional não podem se repetir."
      }
      submitLabel={editing ? "Salvar pessoa" : "Criar pessoa"}
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
            <FormField id="pessoa-unidade" label="Unidade" required error={errors.unit} surface="light">
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

          <FormField id="pessoa-nome" label="Nome" required error={errors.name} surface="light">
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

          <FormField id="pessoa-email" label="E-mail" error={errors.email} surface="light">
            {(field) => (
              <Input
                {...field}
                name="email"
                type="email"
                autoComplete="off"
                maxLength={254}
                value={email}
                disabled={pending}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setErrors((prev) => ({ ...prev, email: undefined }));
                }}
              />
            )}
          </FormField>

          <FormField id="pessoa-identificador" label="Identificador institucional" surface="light">
            {(field) => (
              <Input
                {...field}
                name="institutional_identifier"
                autoComplete="off"
                maxLength={64}
                value={identifier}
                disabled={pending}
                onChange={(event) => setIdentifier(event.target.value)}
              />
            )}
          </FormField>

          {hasPhone ? (
            <FormField
              id="pessoa-telefone"
              label="Telefone"
              surface="light"
              hint="Dado pessoal: visível e editável apenas por administradores. Aceita DDD e separadores."
            >
              {(field) => (
                <Input
                  {...field}
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  maxLength={40}
                  value={phone}
                  disabled={pending}
                  onChange={(event) => setPhone(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
        </>
      )}
    </CatalogFormDialog>
  );
}
