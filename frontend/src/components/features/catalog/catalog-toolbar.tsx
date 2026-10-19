"use client";

import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import { selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { UnitRef } from "@/lib/users-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { SEARCH_MAX, type ActiveFilter } from "./catalog-labels";

// =============================================================================
// CatalogToolbar — busca, filtro por unidade (sigla + nome) e situação.
// Controles nativos estilizados (sem dependências novas). Pílulas com
// aria-pressed dentro de role="group". Tudo vira parâmetro de consulta; o
// backend valida e aplica o escopo de unidade.
// =============================================================================

export interface CatalogToolbarProps {
  idPrefix: string;
  searchLabel: string;
  searchPlaceholder: string;
  search: string;
  onSearch: (value: string) => void;
  /** `undefined` esconde o filtro de unidade. */
  units?: { items: UnitRef[] | undefined; value: string; onChange: (value: string) => void };
  /** `undefined` esconde o filtro de situação. */
  active?: { value: ActiveFilter; onChange: (value: ActiveFilter) => void };
  filtered: boolean;
  onClear: () => void;
}

export function CatalogToolbar({
  idPrefix,
  searchLabel,
  searchPlaceholder,
  search,
  onSearch,
  units,
  active,
  filtered,
  onClear,
}: CatalogToolbarProps) {
  const unitSelectId = `${idPrefix}-filtro-unidade`;
  return (
    <section aria-label="Busca e filtros" className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
        <div className="relative w-full md:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            maxLength={SEARCH_MAX}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        {units ? (
          <div className="flex w-full flex-col gap-1.5 md:w-72">
            <label htmlFor={unitSelectId} className="text-eyebrow text-pale-stone">
              Unidade
            </label>
            <select
              id={unitSelectId}
              className={selectControlClassName}
              value={units.value}
              disabled={!units.items}
              onChange={(event) => units.onChange(event.target.value)}
            >
              <option value="">Todas as unidades</option>
              {units.items?.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {active ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por situação">
            <span className="text-eyebrow text-pale-stone" aria-hidden="true">
              Situação
            </span>
            <FilterPill label="Todas" active={active.value === "all"} onClick={() => active.onChange("all")} />
            <FilterPill label="Ativas" active={active.value === "true"} onClick={() => active.onChange("true")} />
            <FilterPill label="Inativas" active={active.value === "false"} onClick={() => active.onChange("false")} />
          </div>
        ) : null}
        {filtered ? (
          <Button variant="link" size="sm" className="min-h-8" onClick={onClear}>
            Limpar filtros
          </Button>
        ) : null}
      </div>
    </section>
  );
}
