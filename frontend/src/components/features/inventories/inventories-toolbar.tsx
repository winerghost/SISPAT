"use client";

import { Search } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { AccessibleUnit } from "@/lib/catalog-api";
import type { InventorySort } from "@/lib/inventories-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { SEARCH_MAX, STATUS_LABEL, STATUS_OPTIONS } from "./inventory-labels";
import type { StatusFilter, useInventoryFilters } from "./use-inventory-filters";

// =============================================================================
// Busca e filtros de Inventários. Controles nativos estilizados (sem dependências
// novas). Tudo vira parâmetro de consulta; o backend valida a allowlist e aplica
// o escopo de unidade.
// =============================================================================

type Filters = ReturnType<typeof useInventoryFilters>;

export const SORT_OPTIONS: { value: InventorySort; label: string }[] = [
  { value: "-created_at", label: "Mais recentes primeiro" },
  { value: "created_at", label: "Mais antigos primeiro" },
  { value: "name", label: "Nome (A a Z)" },
  { value: "-name", label: "Nome (Z a A)" },
  { value: "-start_date", label: "Início mais recente" },
  { value: "start_date", label: "Início mais antigo" },
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

export function InventoriesToolbar({ filters, units }: { filters: Filters; units: AccessibleUnit[] | undefined }) {
  return (
    <section aria-label="Busca e filtros" className="flex flex-col gap-4">
      <div className="relative w-full md:max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite"
          aria-hidden
        />
        <Input
          type="search"
          aria-label="Buscar inventário por nome"
          placeholder="Buscar por nome…"
          maxLength={SEARCH_MAX}
          value={filters.search}
          onChange={(event) => filters.setSearch(event.target.value)}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="inventarios-filtro-estado"
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
          id="inventarios-filtro-unidade"
          label="Unidade"
          value={filters.unitId}
          onChange={filters.chooseUnit}
          disabled={!units}
        >
          <option value="">Todas as unidades</option>
          {units?.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unitLabel(unit)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="inventarios-ordenacao"
          label="Ordenar por"
          value={filters.sort}
          onChange={(value) => filters.chooseSort(value as InventorySort)}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>

      {filters.filtered ? (
        <div>
          <Button variant="link" size="sm" className="min-h-8" onClick={filters.clear}>
            Limpar filtros
          </Button>
        </div>
      ) : null}
    </section>
  );
}
