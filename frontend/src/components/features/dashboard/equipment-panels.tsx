"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, BarChart3, Download, RefreshCw } from "lucide-react";

import { FadeIn } from "@/components/animations";
import { useAccessibleUnits, useLookupAccess } from "@/components/features/lookup/use-lookup";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import {
  CATEGORY_OPTIONS,
  FAMILIA_LABEL,
  FAMILIA_VALUES,
  NO_PANEL_FILTERS,
  downloadPanelExport,
  exportErrorMessage,
  isHiddenPanelError,
  usePanelData,
  type ExportFormat,
  type PanelFilters,
} from "@/lib/dashboard-equipment-api";
import type { PanelCatalogItem, PanelPref, PanelSize } from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

import { useDashboardPanelPrefs } from "./use-dashboard-panel-prefs";

import { PanelView, isPanelEmpty } from "./equipment-panel-views";

// =============================================================================
// Painéis do catálogo (GET /dashboard/panels): o backend decide QUAIS painéis o
// perfil recebe, a ordem, a visibilidade e o tamanho; aqui só se desenha o que
// veio. Cada painel busca os próprios dados (`/panels/<id>/data`) com os
// filtros de família, unidade e categoria, e tem skeleton, vazio e erro com
// "Tentar novamente" independentes. 404 = inexistente OU proibido (idêntico):
// o painel é apenas omitido. Painel oculto nas preferências nem consulta dados.
// Grade: 1 coluna no celular, 2 em tablet, até 3 no desktop; P = 1 coluna,
// M = 2, G = largura total (limitado às colunas disponíveis).
// =============================================================================

const SPAN: Record<PanelSize, string> = {
  P: "",
  M: "md:col-span-2",
  G: "md:col-span-2 xl:col-span-3",
};

// ---------------------------------------------------------------------------
// Filtros (família, unidade, categoria)
// ---------------------------------------------------------------------------

function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = `eq-${useId().replace(/:/g, "")}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-eyebrow text-pale-stone">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(selectControlClassName, "min-w-0")}
      >
        {children}
      </select>
    </div>
  );
}

function EquipmentFilters({ filters, onChange }: { filters: PanelFilters; onChange: (next: PanelFilters) => void }) {
  const access = useLookupAccess();
  const units = useAccessibleUnits(access.ready);
  const categories = CATEGORY_OPTIONS.filter((c) => !filters.familia || c.familia === filters.familia);
  const active = [filters.unit_id, filters.familia, filters.categoria].filter(Boolean).length;
  return (
    <form
      aria-label="Filtros dos painéis de equipamentos"
      data-equipment-filters
      className="flex flex-col gap-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <SelectField
          label="Família"
          value={filters.familia ?? ""}
          onChange={(value) => {
            const familia = FAMILIA_VALUES.find((f) => f === value);
            const keep = filters.categoria && CATEGORY_OPTIONS.some((c) => c.id === filters.categoria && (!familia || c.familia === familia));
            onChange({ ...filters, familia, categoria: keep ? filters.categoria : undefined });
          }}
        >
          <option value="">Todas</option>
          {FAMILIA_VALUES.map((familia) => (
            <option key={familia} value={familia}>
              {FAMILIA_LABEL[familia]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Unidade"
          value={filters.unit_id ?? ""}
          onChange={(value) => onChange({ ...filters, unit_id: value || undefined })}
          disabled={units.isError}
        >
          <option value="">Todas as unidades visíveis</option>
          {filters.unit_id && !units.data?.units.some((u) => u.id === filters.unit_id) ? (
            <option value={filters.unit_id}>Unidade selecionada</option>
          ) : null}
          {units.data?.units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unitLabel(unit)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Categoria"
          value={filters.categoria ?? ""}
          onChange={(value) => onChange({ ...filters, categoria: value || undefined })}
        >
          <option value="">Todas</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={active === 0}
          onClick={() => onChange(NO_PANEL_FILTERS)}
        >
          Limpar filtros
        </Button>
        <p role="status" className="text-caption text-warm-granite">
          {active === 0 ? "Sem filtros: todos os bens visíveis ao seu perfil." : `${active} filtro(s) ativo(s).`}
        </p>
      </div>
      {units.isError ? (
        <p className="text-caption text-warm-granite">A lista de unidades não pôde ser carregada; o filtro por unidade está indisponível.</p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Exportação (só painéis com exportable=true no catálogo)
// ---------------------------------------------------------------------------

function ExportActions({ panel, filters }: { panel: PanelCatalogItem; filters: PanelFilters }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const run = async (format: ExportFormat) => {
    setBusy(format);
    setMessage(null);
    try {
      const name = await downloadPanelExport(panel.id, format, filters);
      setMessage({ kind: "ok", text: `Arquivo ${name} gerado.` });
    } catch (error) {
      setMessage({ kind: "error", text: exportErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-equipment-export={panel.id}>
      <div className="flex flex-wrap items-center gap-2">
        {(["csv", "xlsx"] as const).map((format) => (
          <Button
            key={format}
            type="button"
            variant="ghost"
            size="sm"
            loading={busy === format}
            disabled={busy !== null}
            onClick={() => void run(format)}
          >
            <Download aria-hidden />
            {`Exportar ${format.toUpperCase()}`}
            <span className="sr-only">{` — ${panel.label}`}</span>
          </Button>
        ))}
      </div>
      <p role={message?.kind === "error" ? "alert" : "status"} className="min-h-[1lh] text-body-sm text-bone">
        {message?.text ?? ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Um painel
// ---------------------------------------------------------------------------

function EquipmentPanel({ panel, size, filters }: { panel: PanelCatalogItem; size: PanelSize; filters: PanelFilters }) {
  const headingId = `eq-panel-${panel.id}`;
  const query = usePanelData(panel.id, filters);
  // 404 = inexistente OU proibido (indistinguível): só oculta, sem alarde.
  if (query.isError && isHiddenPanelError(query.error)) return null;
  const filtered = Boolean(filters.unit_id || filters.familia || filters.categoria);

  return (
    <FadeIn className={cn("min-w-0", SPAN[size])}>
      <section
        aria-labelledby={headingId}
        aria-busy={query.isPending || undefined}
        data-equipment-panel={panel.id}
        data-panel-size={size}
        className="flex h-full min-w-0 flex-col gap-4 rounded-cards border border-carbon-lift p-4 sm:p-5"
      >
        <header className="flex flex-col gap-1">
          <h3 id={headingId} className="text-eyebrow text-pale-stone">
            {panel.label}
          </h3>
          {panel.description ? <p className="text-body-sm text-warm-granite">{panel.description}</p> : null}
        </header>

        {query.isPending ? (
          <LoadingSkeleton variant="cards" count={size === "P" ? 1 : 3} label={`Carregando ${panel.label}`} />
        ) : query.isError ? (
          <div role="alert" data-equipment-error className="flex flex-col items-start gap-3">
            <p className="flex items-start gap-2 text-body-sm text-bone">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
              Não foi possível carregar este painel. Nenhum valor foi estimado.
            </p>
            <Button variant="ghost" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden="true" />
              Tentar novamente
              <span className="sr-only">{` — ${panel.label}`}</span>
            </Button>
          </div>
        ) : isPanelEmpty(query.data) ? (
          <div data-equipment-empty className="flex flex-col items-start gap-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-buttons border border-carbon-lift text-warm-granite">
              <BarChart3 className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="text-body text-bone">{filtered ? "Nenhum bem com estes filtros" : "Nenhum bem para exibir"}</p>
            <p className="max-w-xl text-body-sm text-warm-granite">
              {filtered
                ? "Nenhum bem visível ao seu perfil corresponde aos filtros ativos. Ajuste ou limpe os filtros."
                : "Não há bens deste grupo nas unidades visíveis ao seu perfil. Nenhum gráfico de exemplo é exibido."}
            </p>
          </div>
        ) : (
          <PanelView data={query.data} label={panel.label} />
        )}

        {panel.exportable && query.isSuccess && !isPanelEmpty(query.data) ? (
          <ExportActions panel={panel} filters={filters} />
        ) : null}
      </section>
    </FadeIn>
  );
}

// ---------------------------------------------------------------------------
// Seção
// ---------------------------------------------------------------------------

interface Entry {
  panel: PanelCatalogItem;
  pref: PanelPref;
}

export function EquipmentPanels() {
  const prefs = useDashboardPanelPrefs();
  const [filters, setFilters] = useState<PanelFilters>(NO_PANEL_FILTERS);

  const entries = useMemo<Entry[]>(() => {
    const byId = new Map(prefs.catalog.map((p) => [p.id, p]));
    return prefs.visible.flatMap((pref) => {
      const panel = byId.get(pref.id);
      return panel ? [{ panel, pref }] : [];
    });
  }, [prefs.catalog, prefs.visible]);

  return (
    <section aria-labelledby="eq-section-title" data-equipment-section className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <div className="flex flex-col gap-1">
        <h2 id="eq-section-title" className="text-eyebrow text-pale-stone">
          Equipamentos e mobiliário
        </h2>
        <p className="max-w-page text-body-sm text-warm-granite">
          Painéis do seu perfil, classificados por família e categoria. Os números são contagens do servidor.
        </p>
      </div>

      {prefs.status === "loading" ? (
        <LoadingSkeleton variant="cards" count={3} label="Carregando painéis de equipamentos" />
      ) : prefs.status === "unavailable" ? (
        <div role="alert" data-equipment-catalog-error className="flex flex-col items-start gap-3">
          <p className="flex items-start gap-2 text-body-sm text-bone">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            Não foi possível carregar os painéis. Nenhum valor foi estimado.
          </p>
          <Button variant="ghost" size="sm" onClick={() => void prefs.reload()}>
            <RefreshCw aria-hidden="true" />
            Tentar novamente
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <div data-equipment-catalog-empty className="flex flex-col items-start gap-2">
          <p className="text-body text-bone">Nenhum painel visível</p>
          <p className="max-w-xl text-body-sm text-warm-granite">
            Nenhum painel está disponível ou ativado para o seu perfil. Use “Personalizar painéis” para escolher o que exibir.
          </p>
        </div>
      ) : (
        <>
          <EquipmentFilters filters={filters} onChange={setFilters} />
          <div
            data-equipment-grid
            data-equipment-order={entries.map((e) => e.panel.id).join(",")}
            className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:gap-6 xl:grid-cols-3"
          >
            {entries.map(({ panel, pref }) => (
              <EquipmentPanel key={panel.id} panel={panel} size={pref.size} filters={filters} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
