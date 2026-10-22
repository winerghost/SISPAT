"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Download } from "lucide-react";

import { AnimatedCard, SlideIn } from "@/components/animations";
import { CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { AccessRestrictedPanel } from "@/components/features/modules/access-restricted";
import { useAccessibleUnits } from "@/components/features/lookup/use-lookup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api-client";
import { listInventories } from "@/lib/inventories-api";
import {
  downloadReport,
  getReportCatalog,
  initialReportForm,
  reportErrorMessage,
  validateReportFilters,
  type ReportDef,
  type ReportFormat,
  type ReportFormState,
} from "@/lib/reports-api";
import { cn } from "@/lib/utils";
import { fieldId, ReportFilterField, type LookupSource } from "./report-filters";
import { sortLabel } from "./report-labels";

// =============================================================================
// /relatorios — relatórios e exportações (CSV/XLSX).
// Catálogo, filtros, ordenação e limite vêm de `GET /api/v1/reports`; o arquivo
// de `GET /api/v1/reports/<kind>/export` (fetch autenticado -> Blob -> link
// temporário). Apresentação apenas: perfil, escopo de unidade, limite de linhas,
// proteção contra injeção de fórmulas e auditoria são do backend. As colunas
// listadas são só informativas. Nenhuma mensagem do backend é exibida.
// =============================================================================

const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

type Outcome = { tone: "success" | "empty" | "error"; text: string } | null;

export function ReportsView() {
  const catalog = useQuery({ queryKey: ["reports", "catalog"], queryFn: getReportCatalog, retry, staleTime: 60_000 });

  if (catalog.isPending) return <LoadingSkeleton variant="lines" count={4} label="Carregando relatórios…" />;
  if (catalog.isError) {
    const error = catalog.error;
    if (error instanceof ApiError && error.status === 403) {
      return (
        <AccessRestrictedPanel
          message={
            error.code === "AAL2_REQUIRED"
              ? "Conclua a verificação em duas etapas (MFA) para acessar os relatórios."
              : "Você não tem permissão para acessar os relatórios."
          }
        />
      );
    }
    return (
      <CatalogNotice onRetry={() => void catalog.refetch()} retrying={catalog.isFetching}>
        Não foi possível carregar os relatórios. Tente novamente.
      </CatalogNotice>
    );
  }
  if (catalog.data.reports.length === 0) {
    return <p className="text-body-sm text-warm-granite">Nenhum relatório disponível para o seu perfil.</p>;
  }
  return <ReportsPanel reports={catalog.data.reports} maxRows={catalog.data.max_rows} formats={catalog.data.formats} />;
}

function ReportsPanel({ reports, maxRows, formats }: { reports: ReportDef[]; maxRows: number; formats: ReportFormat[] }) {
  const [selectedId, setSelectedId] = useState(reports[0]!.id);
  const [forms, setForms] = useState<Record<string, ReportFormState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);

  const def = reports.find((report) => report.id === selectedId) ?? reports[0]!;
  const form = forms[def.id] ?? initialReportForm(def);
  const needsUnits = def.filters.some((f) => f.type === "unit");
  const needsInventories = def.filters.some((f) => f.type === "inventory");

  const unitsQuery = useAccessibleUnits(needsUnits);
  const inventoriesQuery = useQuery({
    queryKey: ["reports", "inventories"],
    queryFn: () => listInventories({ page_size: 100, sort: "name" }),
    enabled: needsInventories,
    staleTime: 60_000,
    retry,
  });
  const units: LookupSource = useMemo(
    () => ({
      options: unitsQuery.data?.units.map((unit) => ({ value: unit.id, label: `${unit.code} — ${unit.name}` })),
      loading: needsUnits && unitsQuery.isPending,
      failed: unitsQuery.isError,
    }),
    [unitsQuery.data, unitsQuery.isPending, unitsQuery.isError, needsUnits],
  );
  const inventories: LookupSource = useMemo(
    () => ({
      options: inventoriesQuery.data?.inventories.map((inv) => ({
        value: inv.id,
        label: inv.unit ? `${inv.name} (${inv.unit.code})` : inv.name,
      })),
      loading: needsInventories && inventoriesQuery.isPending,
      failed: inventoriesQuery.isError,
    }),
    [inventoriesQuery.data, inventoriesQuery.isPending, inventoriesQuery.isError, needsInventories],
  );

  function patch(next: Partial<ReportFormState>) {
    setForms((current) => ({ ...current, [def.id]: { ...form, ...next } }));
    setOutcome(null);
  }

  const hasFilters = Object.values(form.filters).some((value) => value.trim() !== "");

  function clearFilters() {
    patch({ filters: {} });
    setErrors({});
  }

  function selectReport(id: string) {
    setSelectedId(id);
    setErrors({});
    setOutcome(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validateReportFilters(def, form.filters);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setOutcome(null);
      const first = def.filters.find((f) => found[f.name]);
      if (first) window.requestAnimationFrame(() => document.getElementById(fieldId(def.id, first.name))?.focus());
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const result = await downloadReport(def, form);
      if (result.rows === 0) {
        setOutcome({
          tone: "empty",
          text: `Nenhum registro encontrado para estes filtros. O arquivo ${result.fileName} foi baixado apenas com o cabeçalho.`,
        });
      } else {
        const count = result.rows === null ? "" : ` com ${result.rows.toLocaleString("pt-BR")} registro(s)`;
        setOutcome({ tone: "success", text: `Arquivo ${result.fileName} gerado${count}. Confira a pasta de downloads.` });
      }
    } catch (error) {
      setOutcome({ tone: "error", text: reportErrorMessage(error, maxRows) });
    } finally {
      setBusy(false);
    }
  }

  const formatLabel = form.format === "csv" ? "CSV" : "XLSX";

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="rel-escolha" className="flex flex-col gap-3">
        <h2 id="rel-escolha" className="text-eyebrow text-pale-stone">
          Escolha o relatório
        </h2>
        <div role="radiogroup" aria-labelledby="rel-escolha" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {reports.map((report) => {
            const checked = report.id === def.id;
            const inputId = `rel-card-${report.id}`;
            return (
              <AnimatedCard key={report.id} className="relative p-0">
                <input
                  id={inputId}
                  type="radio"
                  name="relatorio"
                  value={report.id}
                  checked={checked}
                  disabled={busy}
                  onChange={() => selectReport(report.id)}
                  className="peer sr-only"
                />
                <label
                  htmlFor={inputId}
                  className={cn(
                    "flex h-full cursor-pointer flex-col gap-2 rounded-cards border p-card-padding transition-factory",
                    "peer-focus-visible:ring-1 peer-focus-visible:ring-bone peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-obsidian-canvas",
                    "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
                    checked ? "border-bone" : "border-ash-stroke hover:border-pale-stone",
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-words text-body text-bone">{report.title}</span>
                    {checked ? (
                      <Badge variant="outline">
                        <Check aria-hidden="true" />
                        Selecionado
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-body-sm text-warm-granite">{report.description}</span>
                </label>
              </AnimatedCard>
            );
          })}
        </div>
      </section>

      <SlideIn key={def.id} distance="sm">
        <form
          onSubmit={onSubmit}
          noValidate
          aria-labelledby="rel-opcoes"
          className="flex max-w-page flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
          data-testid="report-form"
        >
          <div className="flex flex-col gap-1">
            <h2 id="rel-opcoes" className="text-body text-bone">
              {def.title}
            </h2>
            <p className="text-body-sm text-warm-granite">
              Os filtros são opcionais. O arquivo só inclui dados das unidades a que você tem acesso e é limitado a{" "}
              {maxRows.toLocaleString("pt-BR")} linhas.
            </p>
          </div>

          {def.filters.length > 0 ? (
            <fieldset className="flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
              <legend className="mb-3 text-eyebrow text-pale-stone">Filtros</legend>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {def.filters.map((filter) => (
                  <ReportFilterField
                    key={filter.name}
                    kind={def.id}
                    filter={filter}
                    value={form.filters[filter.name] ?? ""}
                    error={errors[filter.name]}
                    units={units}
                    inventories={inventories}
                    disabled={busy}
                    onChange={(value) => patch({ filters: { ...form.filters, [filter.name]: value } })}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Ordenar por" id={`rel-${def.id}-sort`}>
              {(field) => (
                <select
                  {...field}
                  className={selectControlClassName}
                  value={form.sort}
                  disabled={busy}
                  onChange={(event) => patch({ sort: event.target.value })}
                >
                  {def.sorts.map((sort) => (
                    <option key={sort} value={sort}>
                      {sortLabel(sort)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0" disabled={busy}>
              <legend className="mb-1.5 text-eyebrow text-pale-stone">Formato do arquivo</legend>
              <div className="flex flex-wrap gap-2">
                {formats.map((format) => (
                  <FormatChoice
                    key={format}
                    format={format}
                    checked={form.format === format}
                    onSelect={() => patch({ format })}
                  />
                ))}
              </div>
            </fieldset>
          </div>

          {def.include_deleted_allowed ? (
            <Switch
              checked={form.includeDeleted}
              disabled={busy}
              onCheckedChange={(includeDeleted) => patch({ includeDeleted })}
              label="Incluir registros excluídos"
              description="Disponível para administradores. Acrescenta bens excluídos logicamente, com a data de exclusão."
            />
          ) : null}

          <section aria-labelledby="rel-colunas" className="flex flex-col gap-2">
            <h3 id="rel-colunas" className="text-eyebrow text-pale-stone">
              Colunas do arquivo
            </h3>
            <ul className="flex flex-wrap gap-1.5" aria-label="Colunas incluídas no arquivo">
              {def.columns.map((column) => (
                <li key={column.key}>
                  <Badge variant="default" className="max-w-full break-words normal-case">
                    {column.label}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-caption text-warm-granite">
              Lista informativa: as colunas seguem o seu perfil e não podem ser alteradas aqui. Datas e horas saem em UTC.
            </p>
          </section>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="light" loading={busy}>
                <Download aria-hidden="true" />
                {busy ? `Gerando ${formatLabel}…` : `Exportar ${formatLabel}`}
              </Button>
              {hasFilters ? (
                <Button type="button" variant="link" size="sm" className="min-h-8" disabled={busy} onClick={clearFilters}>
                  Limpar filtros
                </Button>
              ) : null}
            </div>
            <OutcomeMessage outcome={outcome} />
          </div>
        </form>
      </SlideIn>
    </div>
  );
}

function FormatChoice({ format, checked, onSelect }: { format: ReportFormat; checked: boolean; onSelect: () => void }) {
  const id = `rel-formato-${format}`;
  return (
    <div className="relative">
      <input
        id={id}
        type="radio"
        name="formato"
        value={format}
        checked={checked}
        onChange={onSelect}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        className={cn(
          "inline-flex h-9 min-w-[5.5rem] cursor-pointer items-center justify-center gap-2 rounded-buttons border px-[14px] text-body-sm transition-factory",
          "peer-focus-visible:ring-1 peer-focus-visible:ring-bone peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-obsidian-canvas",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          checked ? "border-bone bg-carbon-lift text-bone" : "border-ash-stroke text-pale-stone hover:border-pale-stone",
        )}
      >
        {checked ? <Check className="size-4" aria-hidden="true" /> : null}
        {format === "csv" ? "CSV" : "XLSX"}
      </label>
    </div>
  );
}

function OutcomeMessage({ outcome }: { outcome: Outcome }): ReactNode {
  // Região viva persistente: a mensagem é anunciada quando o texto muda.
  return (
    <div aria-live="polite" className="min-h-0" data-testid="report-outcome">
      {outcome ? (
        <SlideIn distance="sm" key={outcome.text}>
          {outcome.tone === "error" ? (
            <FormMessage>{outcome.text}</FormMessage>
          ) : outcome.tone === "success" ? (
            <FormMessage tone="success" role="status">
              {outcome.text}
            </FormMessage>
          ) : (
            <p role="status" className="text-body-sm text-pale-stone">
              {outcome.text}
            </p>
          )}
        </SlideIn>
      ) : null}
    </div>
  );
}
