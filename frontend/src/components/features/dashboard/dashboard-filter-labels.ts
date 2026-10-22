"use client";

import { useMemo } from "react";

import { useUnitPeople, useUnitRooms } from "@/components/features/assets/use-asset-lookups";
import { formatCalendarDate } from "@/components/features/assets/asset-labels";
import { useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import {
  BOND_NONE,
  TIPO_NAO_CLASSIFICADO,
  dashboardFilterEntries,
  type DashboardFilterKey,
  type CategoriaFilterValue,
  type DashboardFilters,
  type InventoryFilterValue,
  type LocatedFilterValue,
  type StatusFilterValue,
  type TipoTiFilterValue,
} from "@/lib/dashboard-api";

import { humanizeCode } from "./dashboard-transform";

// =============================================================================
// Rótulos HUMANOS dos filtros do dashboard (resumo "filtros ativos", cabeçalho
// do relatório e opções dos seletores). Nomes de unidade/sala/pessoa vêm das
// consultas de apoio já usadas em Patrimônios (escopo decidido pelo backend);
// sem a consulta (ou fora da lista), o rótulo é genérico — nunca o UUID.
// Tudo é texto renderizado pelo React (escape automático).
// =============================================================================

export const FILTER_NAMES: Record<DashboardFilterKey, string> = {
  unit_id: "Unidade de uso",
  owner_unit_id: "Unidade pertencente",
  room_id: "Sala",
  responsible_person_id: "Pessoa responsável",
  has_room: "Sala cadastrada",
  has_responsible: "Responsável cadastrado",
  located: "Localizado",
  bond_status: "Vínculo",
  tipo: "Tipo",
  registrado_desde: "Registrado desde",
  registrado_ate: "Registrado até",
  inventario: "Inventário",
  movimentacao_pendente: "Movimentação pendente",
  categoria: "Categoria",
  tipo_ti: "Tipo de TI",
  status: "Situação operacional",
};

/** Rótulos pt-BR do vocabulário fechado de classificação (espelha o backend). */
export const CATEGORIA_LABEL: Record<CategoriaFilterValue, string> = {
  TECNOLOGIA: "Tecnologia",
  MOBILIARIO: "Mobiliário",
  VEICULO: "Veículo",
  EQUIPAMENTO: "Equipamento",
  OUTROS: "Outros",
  NAO_CLASSIFICADO: "Não classificado",
};

export const TIPO_TI_LABEL: Record<TipoTiFilterValue, string> = {
  COMPUTADOR: "Computador",
  NOTEBOOK: "Notebook",
  MONITOR: "Monitor",
  IMPRESSORA: "Impressora",
  OUTRO_TI: "Outro item de TI",
  NAO_INFORMADO: "Tipo não informado",
};

export const STATUS_OPERACIONAL_LABEL: Record<StatusFilterValue, string> = {
  EM_USO: "Em uso",
  ESTOQUE: "Em estoque",
  MANUTENCAO: "Em manutenção",
  BAIXADO: "Baixado",
  NAO_INFORMADO: "Não informado",
};

export const LOCATED_FILTER_LABEL: Record<LocatedFilterValue, string> = {
  SIM: "Sim",
  NAO: "Não",
  DESCONHECIDO: "Desconhecido",
};

export const INVENTORY_FILTER_LABEL: Record<InventoryFilterValue, string> = {
  conferido: "Conferido",
  nao_conferido: "Não conferido",
  encontrado: "Encontrado na última conferência",
  nao_encontrado: "Não encontrado na última conferência",
};

export const HAS_ROOM_LABEL = { true: "Com sala", false: "Sem sala" } as const;
export const HAS_RESPONSIBLE_LABEL = { true: "Com responsável", false: "Sem responsável" } as const;
export const PENDING_MOVEMENT_LABEL = { true: "Com movimentação pendente", false: "Sem movimentação pendente" } as const;

export const BOND_NONE_LABEL = "Sem vínculo";
export const LINKED_FALLBACK = "selecionada pelo link";

/** "NOTEBOOK" → "Notebook"; "NAO_CLASSIFICADO" → "Não classificado". */
export function typeLabel(value: string): string {
  return value === TIPO_NAO_CLASSIFICADO ? "Não classificado" : humanizeCode(value);
}

export function bondLabel(value: string): string {
  return value === BOND_NONE ? BOND_NONE_LABEL : value;
}

export interface FilterLabel {
  key: DashboardFilterKey;
  name: string;
  value: string;
}

interface NamedRef {
  id: string;
  name: string;
}

export interface FilterLookups {
  units?: { id: string; code: string; name: string }[];
  rooms?: NamedRef[];
  people?: NamedRef[];
}

/** Rótulos "Nome: valor" na ordem fixa dos filtros (puro; sem consulta). */
export function describeFilters(filters: DashboardFilters, lookups: FilterLookups = {}): FilterLabel[] {
  const unitName = (id: string) => {
    const unit = lookups.units?.find((u) => u.id === id);
    return unit ? unitLabel(unit) : LINKED_FALLBACK;
  };
  const named = (list: NamedRef[] | undefined, id: string) => list?.find((item) => item.id === id)?.name ?? LINKED_FALLBACK;

  return dashboardFilterEntries(filters).map(([key, value]) => {
    let text: string;
    switch (key) {
      case "unit_id":
      case "owner_unit_id":
        text = unitName(value);
        break;
      case "room_id":
        text = named(lookups.rooms, value);
        break;
      case "responsible_person_id":
        text = named(lookups.people, value);
        break;
      case "has_room":
        text = HAS_ROOM_LABEL[value as "true" | "false"];
        break;
      case "has_responsible":
        text = HAS_RESPONSIBLE_LABEL[value as "true" | "false"];
        break;
      case "movimentacao_pendente":
        text = PENDING_MOVEMENT_LABEL[value as "true" | "false"];
        break;
      case "located":
        text = LOCATED_FILTER_LABEL[value as LocatedFilterValue];
        break;
      case "inventario":
        text = INVENTORY_FILTER_LABEL[value as InventoryFilterValue];
        break;
      case "bond_status":
        text = bondLabel(value);
        break;
      case "tipo":
        text = typeLabel(value);
        break;
      case "registrado_desde":
      case "registrado_ate":
        text = formatCalendarDate(value) ?? value;
        break;
      case "categoria":
        text = CATEGORIA_LABEL[value as CategoriaFilterValue];
        break;
      case "tipo_ti":
        text = TIPO_TI_LABEL[value as TipoTiFilterValue];
        break;
      case "status":
        text = STATUS_OPERACIONAL_LABEL[value as StatusFilterValue];
        break;
    }
    return { key, name: FILTER_NAMES[key], value: text };
  });
}

/** Texto corrido: "Vínculo: Ocioso; Localizado: Não". */
export function filtersSentence(labels: FilterLabel[]): string {
  return labels.map((label) => `${label.name}: ${label.value}`).join("; ");
}

/**
 * Consultas de apoio para os rótulos e os seletores (mesmas queryKeys de
 * Patrimônios, cache compartilhado). Sala/pessoa só com unidade escolhida.
 */
export function useFilterLookups(unitId: string | undefined) {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const rooms = useUnitRooms(unitId ?? "", access.ready, false);
  const people = useUnitPeople(unitId ?? "", access.ready, false);
  return { access, units, rooms, people };
}

/** Rótulos dos filtros aplicados, com nomes resolvidos quando disponíveis. */
export function useFilterLabels(filters: DashboardFilters): FilterLabel[] {
  const { units, rooms, people } = useFilterLookups(filters.unit_id);
  return useMemo(
    () =>
      describeFilters(filters, {
        units: units.data?.units,
        rooms: rooms.data?.rooms,
        people: people.data?.people,
      }),
    [filters, units.data, rooms.data, people.data],
  );
}
