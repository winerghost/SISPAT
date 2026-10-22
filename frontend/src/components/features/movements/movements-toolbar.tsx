"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { AssetRecord } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import type { MovementSort } from "@/lib/movements-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { AssetPicker } from "./asset-picker";
import { optionLabel } from "@/components/features/reports/report-labels";
import { STATUS_LABEL, STATUS_OPTIONS, TYPE_OPTIONS } from "./movement-labels";
import type { StatusFilter, TypeFilter, useMovementFilters } from "./use-movement-filters";

// =============================================================================
// Filtros de Movimentações. Controles nativos estilizados (sem dependências
// novas). Tudo vira parâmetro de consulta; o backend valida a allowlist e
// aplica o escopo (origem OU destino no escopo do usuário).
// =============================================================================

type Filters = ReturnType<typeof useMovementFilters>;

const SORT_OPTIONS: { value: MovementSort; label: string }[] = [
  { value: "-created_at", label: "Mais recentes primeiro" },
  { value: "created_at", label: "Mais antigas primeiro" },
  { value: "status", label: "Estado (A a Z)" },
  { value: "-status", label: "Estado (Z a A)" },
];

function SelectField({
  id,
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-eyebrow text-pale-stone">
        {label}
      </label>
      <select
        id={id}
        className={selectControlClassName}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

export function MovementsToolbar({
  filters,
  units,
  pickedAsset,
  onPickAsset,
}: {
  filters: Filters;
  units: AccessibleUnit[] | undefined;
  pickedAsset: AssetRecord | null;
  onPickAsset: (asset: AssetRecord | null) => void;
}) {
  const unitOptions = units?.map((unit) => (
    <option key={unit.id} value={unit.id}>
      {unitLabel(unit)}
    </option>
  ));
  return (
    <section aria-label="Filtros" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="movimentacoes-filtro-estado"
          label="Estado"
          value={filters.status}
          onChange={(value) => filters.chooseStatus(value as StatusFilter)}
        >
          <option value="">Todos os estados</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="movimentacoes-filtro-tipo"
          label="Tipo"
          value={filters.movementType}
          onChange={(value) => filters.chooseType(value as TypeFilter)}
        >
          <option value="">Todos os tipos</option>
          {TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {optionLabel(type)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="movimentacoes-filtro-origem"
          label="Unidade de origem"
          value={filters.originUnitId}
          onChange={filters.chooseOrigin}
          disabled={!units}
        >
          <option value="">Todas as origens</option>
          {unitOptions}
        </SelectField>
        <SelectField
          id="movimentacoes-filtro-destino"
          label="Unidade de destino"
          value={filters.destinationUnitId}
          onChange={filters.chooseDestination}
          disabled={!units}
        >
          <option value="">Todos os destinos</option>
          {unitOptions}
        </SelectField>
        <SelectField
          id="movimentacoes-ordenacao"
          label="Ordenar por"
          value={filters.sort}
          onChange={(value) => filters.chooseSort(value as MovementSort)}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          <label htmlFor="movimentacoes-filtro-de" className="text-eyebrow text-pale-stone">
            Solicitada a partir de
          </label>
          <Input
            id="movimentacoes-filtro-de"
            type="date"
            min="1900-01-01"
            max={filters.to || undefined}
            className="[color-scheme:dark]"
            value={filters.from}
            onChange={(event) => filters.chooseFrom(event.target.value)}
          />
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          <label htmlFor="movimentacoes-filtro-ate" className="text-eyebrow text-pale-stone">
            Solicitada até
          </label>
          <Input
            id="movimentacoes-filtro-ate"
            type="date"
            min={filters.from || "1900-01-01"}
            className="[color-scheme:dark]"
            value={filters.to}
            onChange={(event) => filters.chooseTo(event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <AssetPicker
            idPrefix="movimentacoes-filtro-bem"
            label="Filtrar por bem"
            clearLabel="Remover filtro de bem"
            value={pickedAsset}
            onChange={(asset) => {
              onPickAsset(asset);
              filters.chooseAsset(asset?.id ?? "");
            }}
          />
        </div>
      </div>

      {filters.filtered ? (
        <div>
          <Button
            variant="link"
            size="sm"
            className="min-h-8"
            onClick={() => {
              onPickAsset(null);
              filters.clear();
            }}
          >
            Limpar filtros
          </Button>
        </div>
      ) : null}
    </section>
  );
}
