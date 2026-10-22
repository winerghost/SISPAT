"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import {
  BOND_NONE,
  CATEGORIA_VALUES,
  INVENTORY_VALUES,
  LOCATED_VALUES,
  STATUS_VALUES,
  TECH_FILTER_KEYS,
  TIPO_TI_VALUES,
  countDashboardFilters,
  isValidPeriod,
  useDashboardTypes,
  type DashboardFilterKey,
  type DashboardFilters,
} from "@/lib/dashboard-api";
import { fetchAssetBondStatuses } from "@/lib/assets-api";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { cn } from "@/lib/utils";

import {
  BOND_NONE_LABEL,
  CATEGORIA_LABEL,
  FILTER_NAMES,
  HAS_RESPONSIBLE_LABEL,
  HAS_ROOM_LABEL,
  INVENTORY_FILTER_LABEL,
  LOCATED_FILTER_LABEL,
  PENDING_MOVEMENT_LABEL,
  STATUS_OPERACIONAL_LABEL,
  TIPO_TI_LABEL,
  filtersSentence,
  typeLabel,
  useFilterLabels,
  useFilterLookups,
} from "./dashboard-filter-labels";
import type { DashboardUrlFilters } from "./use-dashboard-url-filters";

// =============================================================================
// Barra de filtros do dashboard (estado na URL — ver use-dashboard-url-filters).
// =============================================================================
// - Visíveis: Unidade de uso, Localizado, Vínculo, Tipo. "Mais filtros" é um
//   disclosure (botão com aria-expanded/aria-controls) com os demais.
// - Controles NATIVOS estilizados (select/date), rótulo visível em cada um,
//   alvos ≥ 24px, teclado completo; grade que vira 1 coluna no celular.
// - Opções: unidades (`/units/accessible`), salas/pessoas da unidade escolhida
//   (`/rooms`, `/responsible-people`), vínculos (`/assets/bond-statuses`) e
//   tipos (`/dashboard/tipos`). Consulta de apoio que falha só desativa o
//   próprio seletor (com aviso); o resto da tela segue.
// - Celular (< 768px, `md`): a barra é recolhível — botão "Filtros (N ativos)"
//   (disclosure com aria-expanded), FECHADA por padrão; a partir de `md` o
//   conteúdo fica sempre visível e o botão some (só CSS: sem flash nem
//   matchMedia). N = filtros APLICADOS (os da URL).
// - Esconder/mostrar filtros é apresentação: escopo e validação são do backend.
// =============================================================================

const ADVANCED_KEYS: readonly DashboardFilterKey[] = [
  "owner_unit_id",
  "room_id",
  "responsible_person_id",
  "has_room",
  "has_responsible",
  "registrado_desde",
  "registrado_ate",
  "inventario",
  "movimentacao_pendente",
  ...TECH_FILTER_KEYS,
];

export const PERIOD_ERROR =
  "Período não aplicado: a data inicial deve ser igual ou anterior à final e o intervalo não pode passar de 5 anos.";

interface Option {
  value: string;
  label: string;
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = "Todos",
  disabled,
  hint,
  fallbackLabel,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
  /** Rótulo do valor vindo do link que não está na lista de opções. */
  fallbackLabel?: string;
}) {
  const missing = value !== "" && !options.some((option) => option.value === value);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-eyebrow text-pale-stone">
        {label}
      </label>
      <select
        id={id}
        className={cn(selectControlClassName, "min-w-0")}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-dica` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {missing ? <option value={value}>{fallbackLabel ?? value}</option> : null}
        {options.map((option, index) => (
          <option key={`${index}:${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-dica`} className="text-caption text-warm-granite">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function DateField({
  id,
  label,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-eyebrow text-pale-stone">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        min="1900-01-01"
        max="9999-12-31"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? describedBy : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 [color-scheme:dark]"
      />
    </div>
  );
}

const boolOptions = (labels: { true: string; false: string }): Option[] => [
  { value: "true", label: labels.true },
  { value: "false", label: labels.false },
];

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function DashboardFilterBar({ state }: { state: DashboardUrlFilters }) {
  const baseId = useId().replace(/:/g, "");
  const id = (key: string) => `dash-filtro-${key}-${baseId}`;
  const { draft, set, clear, hasAny } = state;
  const value = (key: DashboardFilterKey) => (draft as Record<string, string | undefined>)[key] ?? "";

  const advancedActive = ADVANCED_KEYS.filter((key) => value(key) !== "").length;
  const [open, setOpen] = useState(advancedActive > 0);
  const panelId = id("mais");
  // Celular: recolhida por padrão (no desktop o conteúdo é sempre exibido).
  const [mobileOpen, setMobileOpen] = useState(false);
  const bodyId = id("conteudo");
  const activeCount = countDashboardFilters(state.applied);
  const mobileLabel = `Filtros (${activeCount} ${activeCount === 1 ? "ativo" : "ativos"})`;
  const mobileShown = mobileOpen ? "flex" : "hidden";

  const { access, units, rooms, people } = useFilterLookups(draft.unit_id);
  const bondStatuses = useQuery({
    queryKey: ["assets", "bond-statuses"],
    queryFn: fetchAssetBondStatuses,
    enabled: access.ready,
    staleTime: 60_000,
    retry: noClientRetry,
  });
  const types = useDashboardTypes(state.applied, access.ready);

  const unitOptions: Option[] = (units.data?.units ?? []).map((unit) => ({ value: unit.id, label: unitLabel(unit) }));
  const roomOptions: Option[] = (rooms.data?.rooms ?? []).map((room) => ({ value: room.id, label: room.name }));
  const personOptions: Option[] = (people.data?.people ?? []).map((person) => ({ value: person.id, label: person.name }));
  const bondOptions: Option[] = [
    { value: BOND_NONE, label: BOND_NONE_LABEL },
    ...(bondStatuses.data?.items ?? []).map((item) => ({
      value: item.value,
      label: `${item.value} (${item.count.toLocaleString("pt-BR")})`,
    })),
  ];
  const typeOptions: Option[] = (types.data ?? []).map((item) => ({
    value: item.value,
    label: `${typeLabel(item.value)} (${item.count.toLocaleString("pt-BR")})`,
  }));

  const needUnit = value("unit_id") === "";
  const desde = value("registrado_desde");
  const ate = value("registrado_ate");
  const periodInvalid = desde !== "" && ate !== "" && !isValidPeriod(desde, ate);
  const periodErrorId = id("periodo-erro");
  const unitsFailed = units.isError;

  return (
    <section
      aria-labelledby={id("titulo")}
      data-dashboard-filters
      className="flex min-w-0 flex-col gap-4 rounded-cards border border-carbon-lift p-4 sm:p-5 print:hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id("titulo")} className="text-eyebrow text-pale-stone">
          <span className="hidden md:inline">Filtros</span>
          <button
            type="button"
            aria-expanded={mobileOpen}
            aria-controls={bodyId}
            data-dashboard-filters-toggle
            onClick={() => setMobileOpen((current) => !current)}
            className="inline-flex min-h-11 items-center gap-2 rounded-buttons pr-2 text-eyebrow text-pale-stone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone md:hidden"
          >
            {mobileLabel}
            <ChevronDown aria-hidden className={cn("h-4 w-4 transition-factory", mobileOpen && "rotate-180")} />
          </button>
        </h2>
        <div className={cn(mobileShown, "flex-wrap items-center gap-2 md:flex")} data-dashboard-filters-actions>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            Mais filtros{advancedActive > 0 ? ` (${advancedActive})` : ""}
            <ChevronDown aria-hidden className={cn("transition-factory", open && "rotate-180")} />
          </Button>
          <Button variant="ghost" size="sm" onClick={clear} disabled={!hasAny}>
            <X aria-hidden />
            Limpar filtros
          </Button>
        </div>
      </div>

      <div id={bodyId} className={cn(mobileShown, "min-w-0 flex-col gap-4 md:flex")} data-dashboard-filters-body>
        <Grid>
          <SelectField
            id={id("unidade")}
            label={FILTER_NAMES.unit_id}
            value={value("unit_id")}
            onChange={(v) => set("unit_id", v)}
            options={unitOptions}
            placeholder="Todas as unidades"
            disabled={unitsFailed}
            hint={unitsFailed ? "Não foi possível carregar as unidades; filtro indisponível." : undefined}
            fallbackLabel="Unidade selecionada pelo link"
          />
          <SelectField
            id={id("localizado")}
            label={FILTER_NAMES.located}
            value={value("located")}
            onChange={(v) => set("located", v)}
            options={LOCATED_VALUES.map((v) => ({ value: v, label: LOCATED_FILTER_LABEL[v] }))}
          />
          <SelectField
            id={id("vinculo")}
            label={FILTER_NAMES.bond_status}
            value={value("bond_status")}
            onChange={(v) => set("bond_status", v)}
            options={bondOptions}
            disabled={bondStatuses.isError}
            hint={bondStatuses.isError ? "Não foi possível carregar os vínculos; filtro indisponível." : undefined}
          />
          <SelectField
            id={id("tipo")}
            label={FILTER_NAMES.tipo}
            value={value("tipo")}
            onChange={(v) => set("tipo", v)}
            options={typeOptions}
            disabled={types.isError}
            hint={types.isError ? "Não foi possível carregar os tipos; filtro indisponível." : undefined}
            fallbackLabel={value("tipo") ? typeLabel(value("tipo")) : undefined}
          />
        </Grid>

        <div id={panelId} hidden={!open} data-dashboard-more-filters className="flex flex-col gap-4">
          {open ? (
            <>
              <Grid>
                <SelectField
                  id={id("pertencente")}
                  label={FILTER_NAMES.owner_unit_id}
                  value={value("owner_unit_id")}
                  onChange={(v) => set("owner_unit_id", v)}
                  options={unitOptions}
                  placeholder="Todas as unidades"
                  disabled={unitsFailed}
                  fallbackLabel="Unidade selecionada pelo link"
                />
                <SelectField
                  id={id("sala")}
                  label={FILTER_NAMES.room_id}
                  value={value("room_id")}
                  onChange={(v) => set("room_id", v)}
                  options={roomOptions}
                  placeholder="Todas as salas"
                  disabled={(needUnit && value("room_id") === "") || rooms.isError}
                  hint={
                    needUnit
                      ? "Escolha a unidade de uso para filtrar por sala."
                      : rooms.isError
                        ? "Não foi possível carregar as salas."
                        : undefined
                  }
                  fallbackLabel="Sala selecionada pelo link"
                />
                <SelectField
                  id={id("responsavel")}
                  label={FILTER_NAMES.responsible_person_id}
                  value={value("responsible_person_id")}
                  onChange={(v) => set("responsible_person_id", v)}
                  options={personOptions}
                  placeholder="Todas as pessoas"
                  disabled={(needUnit && value("responsible_person_id") === "") || people.isError}
                  hint={
                    needUnit
                      ? "Escolha a unidade de uso para filtrar por pessoa."
                      : people.isError
                        ? "Não foi possível carregar as pessoas."
                        : undefined
                  }
                  fallbackLabel="Pessoa selecionada pelo link"
                />
                <SelectField
                  id={id("inventario")}
                  label={FILTER_NAMES.inventario}
                  value={value("inventario")}
                  onChange={(v) => set("inventario", v)}
                  options={INVENTORY_VALUES.map((v) => ({ value: v, label: INVENTORY_FILTER_LABEL[v] }))}
                />
                <SelectField
                  id={id("com-sala")}
                  label={FILTER_NAMES.has_room}
                  value={value("has_room")}
                  onChange={(v) => set("has_room", v)}
                  options={boolOptions(HAS_ROOM_LABEL)}
                />
                <SelectField
                  id={id("com-responsavel")}
                  label={FILTER_NAMES.has_responsible}
                  value={value("has_responsible")}
                  onChange={(v) => set("has_responsible", v)}
                  options={boolOptions(HAS_RESPONSIBLE_LABEL)}
                />
                <SelectField
                  id={id("movimentacao")}
                  label={FILTER_NAMES.movimentacao_pendente}
                  value={value("movimentacao_pendente")}
                  onChange={(v) => set("movimentacao_pendente", v)}
                  options={boolOptions(PENDING_MOVEMENT_LABEL)}
                />
              </Grid>
              <fieldset className="flex min-w-0 flex-col gap-3" data-dashboard-tech-filters>
                <legend className="mb-3 text-eyebrow text-pale-stone">Classificação (painéis de Tecnologia)</legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <SelectField
                    id={id("categoria")}
                    label={FILTER_NAMES.categoria}
                    value={value("categoria")}
                    onChange={(v) => set("categoria", v)}
                    options={CATEGORIA_VALUES.map((v) => ({ value: v, label: CATEGORIA_LABEL[v] }))}
                    hint="Vale só para os painéis de Tecnologia."
                  />
                  <SelectField
                    id={id("tipo-ti")}
                    label={FILTER_NAMES.tipo_ti}
                    value={value("tipo_ti")}
                    onChange={(v) => set("tipo_ti", v)}
                    options={TIPO_TI_VALUES.map((v) => ({ value: v, label: TIPO_TI_LABEL[v] }))}
                  />
                  <SelectField
                    id={id("status-operacional")}
                    label={FILTER_NAMES.status}
                    value={value("status")}
                    onChange={(v) => set("status", v)}
                    options={STATUS_VALUES.map((v) => ({ value: v, label: STATUS_OPERACIONAL_LABEL[v] }))}
                  />
                </div>
              </fieldset>
              <fieldset className="flex min-w-0 flex-col gap-3">
                <legend className="mb-3 text-eyebrow text-pale-stone">Período de registro</legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <DateField
                    id={id("desde")}
                    label="De"
                    value={desde}
                    onChange={(v) => set("registrado_desde", v)}
                    invalid={periodInvalid}
                    describedBy={periodErrorId}
                  />
                  <DateField
                    id={id("ate")}
                    label="Até"
                    value={ate}
                    onChange={(v) => set("registrado_ate", v)}
                    invalid={periodInvalid}
                    describedBy={periodErrorId}
                  />
                </div>
                <p id={periodErrorId} aria-live="polite" className="text-body-sm text-bone">
                  {periodInvalid ? PERIOD_ERROR : ""}
                </p>
              </fieldset>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Resumo dos filtros APLICADOS (os da URL, que foram às consultas), acima dos
 * números. role="status": a troca é anunciada sem roubar o foco.
 */
export function DashboardFilterSummary({ filters }: { filters: DashboardFilters }) {
  const labels = useFilterLabels(filters);
  const techOnly = labels.some((label) => (TECH_FILTER_KEYS as readonly string[]).includes(label.key));
  return (
    <p role="status" data-dashboard-filter-summary className="min-w-0 break-words text-body-sm text-warm-granite">
      {labels.length > 0 ? (
        <>
          <span className="text-bone">Os números refletem os filtros: </span>
          {filtersSentence(labels)}.
          {techOnly ? " Categoria, tipo de TI e situação operacional filtram só os painéis de Tecnologia." : ""}
        </>
      ) : (
        "Sem filtros: os números refletem todos os bens visíveis para o seu perfil."
      )}
    </p>
  );
}
