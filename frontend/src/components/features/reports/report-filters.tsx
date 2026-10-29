"use client";

import { Input } from "@/components/ui/input";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { cn } from "@/lib/utils";
import { isReportLookupType, type ReportFilterDef, type ReportLookupType } from "@/lib/reports-api";
import { allOptionLabel, FILTER_HINT, filterLabel, optionLabel, orderedOptions } from "./report-labels";

// =============================================================================
// Campos de filtro GERADOS a partir do catálogo (`filters[]`). O tipo decide o
// controle nativo:
//   - LOOKUP (`unit`, `inventory`, `room`, `person`) -> <select> com a lista
//     carregada da API (um `LookupSource` por tipo, vindo de `reports-view`);
//   - `enum` (ou qualquer filtro que traga `options`, como `bond_status`)
//     -> <select> de opções fixas do catálogo;
//   - `date` -> <input type="date">; o RESTO (`text`, `uuid`) -> <input text>.
// Enquanto o catálogo declarar sala/responsável como `uuid`, o campo continua
// livre (degradação) — o controle segue o contrato, sem adivinhar.
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

export type ReportLookups = Record<ReportLookupType, LookupSource>;

/** Rótulos de cada lookup: opção "sem filtro" e aviso de lista indisponível. */
const LOOKUP_TEXT: Record<ReportLookupType, { all: string; unavailable: string }> = {
  unit: { all: "Todas as unidades", unavailable: "Lista de unidades indisponível no momento." },
  inventory: {
    all: "Todos os inventários",
    unavailable: "Lista de inventários indisponível para o seu perfil ou no momento.",
  },
  room: { all: "Todas as salas", unavailable: "Lista de salas indisponível para o seu perfil ou no momento." },
  person: {
    all: "Todos os responsáveis",
    unavailable: "Lista de responsáveis indisponível para o seu perfil ou no momento.",
  },
};

export function fieldId(kind: string, name: string): string {
  return `rel-${kind}-${name}`;
}

/**
 * Opção para o valor que já estava escolhido e NÃO está mais entre as opções
 * (sala inativada, vínculo que saiu da planilha, inventário fora do escopo):
 * a escolha é preservada e continua enviável — o backend decide se vale.
 */
function PreviousChoice({ value, known }: { value: string; known: boolean }) {
  if (known) return null;
  return <option value={value}>Selecionado anteriormente</option>;
}

/** Ordem alfabética ESTÁVEL (desempate pelo valor) para as listas carregadas. */
export function sortLookupOptions(options: LookupOption[]): LookupOption[] {
  return [...options].sort(
    (a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }) || a.value.localeCompare(b.value),
  );
}

/**
 * Opções de sala/responsável: nome do registro, ordenado. Quando o MESMO nome
 * aparece em mais de uma unidade (salas homônimas, pessoas homônimas), o código
 * da unidade é acrescentado para a escolha não ficar ambígua — só quando a
 * lista de unidades do escopo já está carregada (senão fica apenas o nome).
 */
export function scopedLookupOptions(
  items: readonly { id: string; name: string; unit_id: string }[] | undefined,
  unitCodeById: ReadonlyMap<string, string>,
): LookupOption[] | undefined {
  if (!items) return undefined;
  const times = new Map<string, number>();
  for (const item of items) times.set(item.name, (times.get(item.name) ?? 0) + 1);
  return sortLookupOptions(
    items.map((item) => {
      const code = (times.get(item.name) ?? 0) > 1 ? unitCodeById.get(item.unit_id) : undefined;
      return { value: item.id, label: code ? `${item.name} (${code})` : item.name };
    }),
  );
}

export function ReportFilterField({
  kind,
  filter,
  value,
  error,
  lookups,
  disabled,
  onChange,
}: {
  kind: string;
  filter: ReportFilterDef;
  value: string;
  error?: string;
  lookups: ReportLookups;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = filterLabel(filter.name);
  const id = fieldId(kind, filter.name);

  // Lookups: mesma forma para unidade, inventário, sala e responsável — lista
  // carregada, "Todas as…", "Carregando…", aviso de indisponível e o valor
  // escolhido antes que saiu da lista.
  if (isReportLookupType(filter.type)) {
    const source = lookups[filter.type];
    const text = LOOKUP_TEXT[filter.type];
    const known = !value || !!source.options?.some((option) => option.value === value);
    return (
      <FormField label={label} id={id} error={error} hint={source.failed ? text.unavailable : undefined}>
        {(field) => (
          <select
            {...field}
            className={selectControlClassName}
            value={value}
            disabled={disabled || (!source.options && !value)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{source.loading ? "Carregando…" : text.all}</option>
            {source.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <PreviousChoice value={value} known={known} />
          </select>
        )}
      </FormField>
    );
  }

  // Opções fixas do catálogo. `bond_status` chega assim quando o backend manda
  // os valores existentes no escopo (+ a sentinela `__none__` = "Sem vínculo").
  const options = filter.options ?? [];
  if (filter.type === "enum" || options.length > 0) {
    // `options: []` é lista vazia LEGÍTIMA (ex.: usuário sem unidade no escopo),
    // não falha: o campo fica com apenas a opção "todos".
    const known = !value || options.includes(value);
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
            <option value="">{allOptionLabel(filter.name)}</option>
            {orderedOptions(filter.name, options).map((option) => (
              <option key={option} value={option}>
                {optionLabel(option)}
              </option>
            ))}
            <PreviousChoice value={value} known={known} />
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
