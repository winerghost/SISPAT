"use client";

import { Search } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BOND_STATUS_NONE, type AssetBondStatusOption } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import {
  ASSET_SEARCH_MAX,
  BOND_STATUS_NONE_LABEL,
  BOND_STATUS_UNAVAILABLE_MESSAGE,
  bondStatusOptionLabel,
  LOCATED_LABEL,
  LOCATED_OPTIONS,
} from "./asset-labels";
import type { LocatedFilter, useAssetFilters } from "./use-asset-filters";

// =============================================================================
// Busca e filtros de Patrimônios. Controles nativos estilizados (sem
// dependências novas). Sala e responsável pertencem a uma unidade: ficam
// desativados até escolher a unidade (evita listas truncadas em 100 itens).
// "Incluir excluídos" só aparece para ADM (UX; o backend responde 403 aos
// demais). "Vínculo" lista as opções de `GET /assets/bond-statuses` (contagem do
// backend) + "Sem vínculo"; se o endpoint falhar, o filtro fica desativado com
// aviso e a lista segue. Tudo vira parâmetro de consulta; o backend valida e
// aplica o escopo.
// =============================================================================

type Filters = ReturnType<typeof useAssetFilters>;

interface Option {
  id: string;
  name: string;
}

function SelectField({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  hint?: string;
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
        aria-describedby={hint ? `${id}-dica` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
      {hint ? (
        <p id={`${id}-dica`} className="text-caption text-warm-granite">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AssetsToolbar({
  filters,
  units,
  rooms,
  people,
  bondStatuses,
  bondStatusesFailed,
  isAdmin,
}: {
  filters: Filters;
  units: AccessibleUnit[] | undefined;
  rooms: Option[] | undefined;
  people: Option[] | undefined;
  /** `undefined` enquanto carrega. */
  bondStatuses: AssetBondStatusOption[] | undefined;
  bondStatusesFailed: boolean;
  isAdmin: boolean;
}) {
  const needUnit = filters.unitId === "";
  return (
    <section aria-label="Busca e filtros" className="flex flex-col gap-4">
      <div className="relative w-full md:max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite"
          aria-hidden
        />
        <Input
          type="search"
          aria-label="Buscar por número patrimonial ou descrição"
          placeholder="Buscar por patrimônio ou descrição…"
          maxLength={ASSET_SEARCH_MAX}
          value={filters.search}
          onChange={(event) => filters.setSearch(event.target.value)}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <SelectField
          id="patrimonios-filtro-unidade"
          label="Unidade"
          value={filters.unitId}
          onChange={filters.chooseUnit}
          disabled={!units}
          placeholder="Todas as unidades"
        >
          {units?.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unitLabel(unit)}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="patrimonios-filtro-sala"
          label="Sala"
          value={filters.roomId}
          onChange={filters.chooseRoom}
          disabled={needUnit || !rooms}
          placeholder="Todas as salas"
          hint={needUnit ? "Escolha uma unidade para filtrar por sala." : undefined}
        >
          {rooms?.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="patrimonios-filtro-responsavel"
          label="Responsável"
          value={filters.personId}
          onChange={filters.choosePerson}
          disabled={needUnit || !people}
          placeholder="Todos os responsáveis"
          hint={needUnit ? "Escolha uma unidade para filtrar por responsável." : undefined}
        >
          {people?.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="patrimonios-filtro-localizado"
          label="Localizado"
          value={filters.located}
          onChange={(value) => filters.chooseLocated(value as LocatedFilter)}
          placeholder="Todos"
        >
          {LOCATED_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {LOCATED_LABEL[status]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="patrimonios-filtro-vinculo"
          label="Vínculo"
          value={filters.bondStatus}
          onChange={filters.chooseBondStatus}
          disabled={bondStatusesFailed || !bondStatuses}
          placeholder="Todos"
          hint={bondStatusesFailed ? BOND_STATUS_UNAVAILABLE_MESSAGE : undefined}
        >
          <option value={BOND_STATUS_NONE}>{BOND_STATUS_NONE_LABEL}</option>
          {bondStatuses?.map((option, index) => (
            <option key={`${index}:${option.value}`} value={option.value}>
              {bondStatusOptionLabel(option)}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {isAdmin ? (
          <Switch
            id="patrimonios-incluir-excluidos"
            checked={filters.includeDeleted}
            onCheckedChange={filters.chooseIncludeDeleted}
            label="Incluir excluídos"
            description="Mostra também bens excluídos (exclusão lógica). Só administradores."
          />
        ) : null}
        {filters.filtered ? (
          <Button variant="link" size="sm" className="min-h-8" onClick={filters.clear}>
            Limpar filtros
          </Button>
        ) : null}
      </div>
    </section>
  );
}
