"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { SearchX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { StatusIndicator } from "@/components/ui/status-indicator";
import {
  AnimatedTableBody,
  AnimatedTableRow,
  Table,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api-client";
import {
  getGoogleSheetsPreviewItems,
  type ImportItemClassification,
  type ImportPreviewItem,
} from "@/lib/imports-api";

import { CLASSIFICATION_META } from "./classification";

// =============================================================================
// PreviewItemsTable
// =============================================================================
// Tabela paginada no servidor (TanStack Table + TanStack Query) para revisão
// dos itens de uma prévia de importação. Busca (debounced) e filtro por
// classificação disparam novas requisições `GET /items`; a paginação usa
// `page`/`page_size`/`total` retornados pela API (nunca client-side).
//
// Seleção: a API não expõe um endpoint de "selecionar/desselecionar item"
// nem um "selecionar todos" — cada página de itens já vem com um campo
// `selected` (default do backend). Este componente mantém:
//   - `itemsCacheRef`: todo item já visto (qualquer página/filtro/busca),
//     para que a contagem de selecionados sobreviva à troca de página.
//   - `overrides`: toggles explícitos do usuário sobre o default do backend.
// O resumo de seleção (ids elegíveis selecionados + contagens por
// classificação) é repassado ao componente pai via `onSelectionSummaryChange`
// a cada mudança, para habilitar o botão "Confirmar Importação" e alimentar
// o diálogo de confirmação.
//
// Linhas DUPLICADO/INVALIDO/CONFLITANTE nunca são selecionáveis (checkbox
// desabilitado) — apenas NOVO/EXISTENTE podem ser marcadas.
//
// Motion (DESIGN.md: 150–200 ms, sem spring): ao filtrar/buscar/paginar os
// resultados anteriores continuam visíveis (keepPreviousData), esmaecidos e
// com aria-busy, até a resposta real chegar; então o <tbody> é remontado e
// só as linhas da página (máx. 20) entram com fade + 4px escalonado. Linha
// selecionada = `data-state="selected"` (fundo carbon-lift) + checkbox.
// Não há ordenação: o endpoint não aceita parâmetro de ordenação.
// =============================================================================

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 400;

const CLASSIFICATIONS = Object.keys(CLASSIFICATION_META) as ImportItemClassification[];

function isEligible(classification: ImportItemClassification): boolean {
  return classification === "NOVO" || classification === "EXISTENTE";
}

function ineligibleReason(item: ImportPreviewItem): string {
  switch (item.classification) {
    case "DUPLICADO":
      return "Registro duplicado na planilha de origem — não pode ser selecionado para importação.";
    case "INVALIDO":
      return item.validation_errors?.length
        ? `Registro inválido: ${item.validation_errors.join("; ")}`
        : "Registro inválido — corrija a planilha de origem antes de importar.";
    case "CONFLITANTE":
      return "Conflito com um registro existente — requer revisão manual antes de importar.";
    default:
      return "";
  }
}

export interface SelectionSummary {
  selectedIds: string[];
  novoCount: number;
  existenteCount: number;
}

interface PreviewItemsTableProps {
  previewId: string;
  onSelectionSummaryChange: (summary: SelectionSummary) => void;
}

export function PreviewItemsTable({ previewId, onSelectionSummaryChange }: PreviewItemsTableProps) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ImportItemClassification | undefined>(undefined);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  const itemsCacheRef = useRef<Map<string, ImportPreviewItem>>(new Map());

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const { data, isLoading, isFetching, isPlaceholderData, isError, error, refetch } = useQuery({
    queryKey: ["import-preview-items", previewId, page, PAGE_SIZE, statusFilter, debouncedSearch],
    queryFn: () =>
      getGoogleSheetsPreviewItems(previewId, {
        page,
        page_size: PAGE_SIZE,
        status: statusFilter,
        search: debouncedSearch || undefined,
      }),
    staleTime: 10_000,
    // Mantém as linhas anteriores durante a troca de filtro/página (sem
    // "piscar" para skeleton); a tabela fica esmaecida + aria-busy.
    placeholderData: keepPreviousData,
  });

  // Chave do <tbody>: só muda quando os dados do NOVO filtro/página chegam
  // (nunca durante o placeholder), remontando o corpo para a entrada
  // escalonada. Atribuição idempotente durante o render (sem efeito colateral).
  const filterKey = `${page}|${statusFilter ?? ""}|${debouncedSearch}`;
  const shownKeyRef = useRef(filterKey);
  if (data && !isPlaceholderData) shownKeyRef.current = filterKey;
  const busy = isFetching && !isLoading;

  useEffect(() => {
    if (!data) return;
    for (const item of data.items) {
      itemsCacheRef.current.set(item.id, item);
    }
  }, [data]);

  function effectiveSelected(item: ImportPreviewItem): boolean {
    if (!isEligible(item.classification)) return false;
    return overrides.get(item.id) ?? item.selected;
  }

  function toggle(item: ImportPreviewItem) {
    if (!isEligible(item.classification)) return;
    const current = effectiveSelected(item);
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(item.id, !current);
      return next;
    });
  }

  useEffect(() => {
    const selectedIds: string[] = [];
    let novoCount = 0;
    let existenteCount = 0;
    for (const item of itemsCacheRef.current.values()) {
      if (!isEligible(item.classification)) continue;
      const selected = overrides.get(item.id) ?? item.selected;
      if (!selected) continue;
      selectedIds.push(item.id);
      if (item.classification === "NOVO") novoCount += 1;
      else existenteCount += 1;
    }
    onSelectionSummaryChange({ selectedIds, novoCount, existenteCount });
    // `data` entra nas dependências para recalcular quando uma nova página é
    // incorporada ao cache acumulado (itemsCacheRef não dispara re-render por si).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, data, onSelectionSummaryChange]);

  const columns = useMemo<ColumnDef<ImportPreviewItem>[]>(
    () => [
      {
        id: "select",
        header: "Sel.",
        cell: ({ row }) => {
          const item = row.original;
          const eligible = isEligible(item.classification);
          const checked = effectiveSelected(item);
          const reason = eligible ? undefined : ineligibleReason(item);
          // O <label> de 24x24px amplia a área de toque do checkbox de 16px
          // (WCAG 2.5.8 Target Size Minimum) sem alterar o visual.
          return (
            <label className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm transition-factory hover:bg-carbon-lift has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent">
              <input
                type="checkbox"
                checked={checked}
                disabled={!eligible}
                onChange={() => toggle(item)}
                title={reason}
                aria-label={eligible ? `Selecionar item ${item.patrimony_number}` : reason}
                className="h-4 w-4 cursor-pointer rounded-sm border border-ash-stroke bg-carbon-lift accent-metric-green disabled:cursor-not-allowed disabled:opacity-40"
              />
            </label>
          );
        },
      },
      {
        accessorKey: "patrimony_number",
        header: "Patrimônio",
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap font-mono text-body-sm">{String(getValue() ?? "—")}</span>
        ),
      },
      {
        accessorKey: "description",
        header: "Descrição",
        // Descrições longas quebram dentro da célula (largura mínima legível);
        // a tabela rola horizontalmente no próprio contêiner, nunca a página.
        cell: ({ getValue }) => (
          <span className="block min-w-[14rem] max-w-prose break-words text-body-sm [overflow-wrap:anywhere]">
            {String(getValue() ?? "—")}
          </span>
        ),
      },
      {
        accessorKey: "classification",
        header: "Classificação",
        cell: ({ getValue }) => {
          const meta = CLASSIFICATION_META[getValue() as ImportItemClassification];
          const Icon = meta.icon;
          // Ícone + texto: a cor nunca é o único sinal (WCAG 1.4.1).
          return (
            <Badge variant={meta.badge} className="whitespace-nowrap">
              <Icon aria-hidden="true" />
              {meta.label}
            </Badge>
          );
        },
      },
    ],
    // `overrides` é lido dentro das closures acima (effectiveSelected/toggle);
    // recriar as colunas quando ele muda garante que o checkbox reflita o
    // estado mais recente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overrides],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por patrimônio ou descrição…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full sm:max-w-xs"
          aria-label="Buscar itens da prévia"
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por classificação">
          <FilterPill
            label="Todos"
            active={statusFilter === undefined}
            onClick={() => {
              setStatusFilter(undefined);
              setPage(1);
            }}
          />
          {CLASSIFICATIONS.map((key) => (
            <FilterPill
              key={key}
              label={CLASSIFICATION_META[key].label}
              active={statusFilter === key}
              onClick={() => {
                setStatusFilter(key);
                setPage(1);
              }}
            />
          ))}
        </div>
      </div>

      {isError && (
        <div className="flex flex-col gap-2 rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
          <FormMessage>
            {error instanceof ApiError && error.status === 404
              ? "Esta prévia expirou ou não foi encontrada. Gere uma nova pré-visualização."
              : "Não foi possível carregar os itens desta prévia. Tente novamente."}
          </FormMessage>
          <Button variant="outline" size="sm" className="self-start" onClick={() => refetch()}>
            Tentar novamente
          </Button>
        </div>
      )}

      {isLoading ? (
        <LoadingSkeleton variant="table" count={6} columns={4} label="Carregando itens da prévia…" />
      ) : (
        <Table busy={busy}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent focus-within:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <AnimatedTableBody key={shownKeyRef.current} limit={PAGE_SIZE}>
            {table.getRowModel().rows.length === 0 ? (
              <TableEmpty
                colSpan={columns.length}
                icon={SearchX}
                title="Nenhum item encontrado para os filtros atuais."
                description="Ajuste a busca ou escolha outra classificação."
              />
            ) : (
              table.getRowModel().rows.map((row, index) => (
                <AnimatedTableRow
                  key={row.id}
                  index={index}
                  data-state={effectiveSelected(row.original) ? "selected" : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </AnimatedTableRow>
              ))
            )}
          </AnimatedTableBody>
        </Table>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-caption text-pale-stone" aria-live="polite">
            {total > 0 ? `Página ${page} de ${pageCount} — ${total} item(ns)` : "—"}
          </span>
          {busy ? <StatusIndicator state="loading" label="Atualizando…" /> : null}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount || isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Próxima
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // min-h-8 (32px): alvo de toque >= 24px (WCAG 2.5.8).
        "inline-flex min-h-8 items-center rounded-buttons border px-3 py-1 text-caption uppercase tracking-tight transition-factory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas",
        active
          ? "border-bone text-bone"
          : "border-ash-stroke text-warm-granite hover:border-chalk hover:text-chalk",
      )}
    >
      {label}
    </button>
  );
}
