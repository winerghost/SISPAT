"use client";

import { Input } from "@/components/ui/input";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { cn } from "@/lib/utils";
import type { ReportFilterDef } from "@/lib/reports-api";
import { FILTER_HINT, filterLabel, optionLabel } from "./report-labels";

// =============================================================================
// Campos de filtro GERADOS a partir do catálogo (`filters[]`). O tipo decide o
// controle nativo: text/uuid -> input, enum -> select, date -> input date,
// unit -> select (units/accessible), inventory -> select (lista de inventários).
// Controles só apresentam; o backend valida e aplica o escopo de unidade.
// =============================================================================

export interface LookupOption {
  value: string;
  label: string;
}

export interface LookupSource {
  options: LookupOption[] | undefined;
  loading: boolean;
  failed: boolean;
}

export function fieldId(kind: string, name: string): string {
  return `rel-${kind}-${name}`;
}

export function ReportFilterField({
  kind,
  filter,
  value,
  error,
  units,
  inventories,
  disabled,
  onChange,
}: {
  kind: string;
  filter: ReportFilterDef;
  value: string;
  error?: string;
  units: LookupSource;
  inventories: LookupSource;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = filterLabel(filter.name);
  const id = fieldId(kind, filter.name);

  if (filter.type === "unit" || filter.type === "inventory") {
    const source = filter.type === "unit" ? units : inventories;
    const all = filter.type === "unit" ? "Todas as unidades" : "Todos os inventários";
    const known = !value || !!source.options?.some((option) => option.value === value);
    return (
      <FormField
        label={label}
        id={id}
        error={error}
        hint={
          source.failed
            ? filter.type === "unit"
              ? "Lista de unidades indisponível no momento."
              : "Lista de inventários indisponível para o seu perfil ou no momento."
            : undefined
        }
      >
        {(field) => (
          <select
            {...field}
            className={selectControlClassName}
            value={value}
            disabled={disabled || (!source.options && !value)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{source.loading ? "Carregando…" : all}</option>
            {source.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!known ? <option value={value}>Selecionado anteriormente</option> : null}
          </select>
        )}
      </FormField>
    );
  }

  if (filter.type === "enum") {
    return (
      <FormField label={label} id={id} error={error}>
        {(field) => (
          <select
            {...field}
            className={selectControlClassName}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Todos</option>
            {(filter.options ?? []).map((option) => (
              <option key={option} value={option}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        )}
      </FormField>
    );
  }

  return (
    <FormField label={label} id={id} error={error} hint={FILTER_HINT[filter.name]}>
      {(field) => (
        <Input
          {...field}
          type={filter.type === "date" ? "date" : "text"}
          value={value}
          disabled={disabled}
          maxLength={filter.type === "date" ? undefined : (filter.max_length ?? 100)}
          autoComplete="off"
          spellCheck={false}
          className={cn("min-w-0", filter.type === "date" && "[color-scheme:dark]")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}
