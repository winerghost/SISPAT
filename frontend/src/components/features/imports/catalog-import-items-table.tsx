"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Phone, Search, SearchX, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
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
import { CatalogNotice, CatalogPagination } from "@/components/features/catalog/catalog-parts";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import {
  getCatalogImportItems,
  type CatalogImportItem,
  type CatalogImportKind,
  type CatalogImportSort,
} from "@/lib/catalog-imports-api";
import type { ImportItemClassification } from "@/lib/imports-api";
import { cn } from "@/lib/utils";

import { CLASSIFICATION_META } from "./classification";
import { CATALOG_KIND_LABEL, catalogImportErrorMessage, isPreviewGone, pendingLabel, toTextList } from "./catalog-import-labels";
import {
  ineligibleReason,
  isEligible,
  isItemSelected,
  toggleItem,
  type AliasOptIn,
  type CatalogSelection,
} from "./catalog-import-selection";

// =============================================================================
// CatalogImportItemsTable — itens de uma prévia de cadastros, paginados e
// filtrados NO SERVIDOR (`status`, `search`, `sort` da allowlist, `page`).
// Seleção: checkbox só em NOVO/EXISTENTE (os demais exigem revisão na planilha).
// Telefone nunca é exibido (só "informado/não informado"); e-mail já vem
// mascarado do backend. Textos são escapados pelo React. Motion: linhas
// escalonadas ao trocar página/filtro; durante o carregamento a tabela anterior
// fica esmaecida (`busy`). Rola na horizontal só dentro do contêiner.
// =============================================================================

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_MAX = 100;
const CLASSIFICATIONS = Object.keys(CLASSIFICATION_META) as ImportItemClassification[];
const ALIAS_HELP_ID = "catalog-alias-help";
const WRAP ="min-w-0 break-words [overflow-wrap:anywhere]";

interface Props {
  previewId: string;
  kind: CatalogImportKind;
  selection: CatalogSelection;
  onSelectionChange: (next: CatalogSelection) => void;
  /** Opt-in de sigla de atalho por item (só unidades). */
  aliasOptIn: AliasOptIn;
  onAliasOptInChange: (next: AliasOptIn) => void;
  /** Total de itens elegíveis (NOVO + EXISTENTE) vindo do `summary` do backend. */
  eligibleTotal: number;
  /** A prévia sumiu/expirou no servidor (404/409): a tela pede uma nova. */
  onPreviewGone: () => void;
  disabled?: boolean;
}

interface AliasControl {
  checked: boolean;
  /** Só pode optar por sigla em item selecionado para importação. */
  disabled: boolean;
  onChange: () => void;
}

function Detail({
  item,
  kind,
  alias,
}: {
  item: CatalogImportItem;
  kind: CatalogImportKind;
  alias?: AliasControl;
}) {
  const d = item.details ?? {};
  const unit = d.unidade_sigla ? `Unidade ${d.unidade_sigla}` : null;
  if (kind === "units") {
    return (
      <div className={cn("flex flex-col gap-0.5", WRAP)}>
        <span>{d.unit_name ?? "—"}</span>
        <span className="text-caption text-warm-granite">
          {d.unit_code ? `Código ${d.unit_code}` : "Sem código"}
          {unit ? ` · ${unit}` : ""}
        </span>
        {alias ? (
          <label className="mt-1 flex min-h-6 cursor-pointer items-start gap-2 text-caption has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <input
              type="checkbox"
              data-alias-optin
              checked={alias.checked}
              disabled={alias.disabled}
              onChange={alias.onChange}
              aria-label={`Criar sigla de atalho para esta unidade (${d.unit_name ?? item.label ?? "sem nome"})`}
              aria-describedby={ALIAS_HELP_ID}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-ash-stroke bg-carbon-lift accent-metric-green disabled:cursor-not-allowed"
            />
            <span>Criar sigla de atalho para esta unidade</span>
          </label>
        ) : null}
      </div>
    );
  }
  if (kind === "rooms") {
    return (
      <div className={cn("flex flex-col gap-1", WRAP)}>
        <span className="text-caption text-warm-granite">{unit ?? "Sem unidade"}</span>
        {d.probable_duplicate ? (
          <Badge variant="warning" className="self-start">
            <TriangleAlert aria-hidden="true" />
            Provável duplicata
          </Badge>
        ) : null}
      </div>
    );
  }
  const reasons = toTextList(d.suspect);
  return (
    <div className={cn("flex flex-col gap-0.5", WRAP)}>
      <span className="text-caption text-warm-granite">{unit ?? "Sem unidade"}</span>
      <span className="text-caption text-warm-granite">
        E-mail: {d.email_masked ?? (d.has_email ? "informado" : "não informado")}
      </span>
      <span className="inline-flex items-center gap-1 text-caption text-warm-granite">
        <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
        Telefone: {d.has_phone ? "informado (oculto)" : "não informado"}
      </span>
      {reasons.length > 0 ? (
        <Badge variant="warning" className="self-start">
          <TriangleAlert aria-hidden="true" />
          Nome suspeito
        </Badge>
      ) : null}
    </div>
  );
}

function Warnings({ item }: { item: CatalogImportItem }) {
  const reasons = toTextList(item.details?.suspect);
  const notes = [
    ...(item.id_conflict ? ["ID repetido na planilha"] : []),
    ...item.pendencias.map(pendingLabel),
    ...item.validation_errors,
    ...reasons.map((reason) => `Nome suspeito: ${reason}`),
  ];
  if (notes.length === 0) return <span className="text-warm-granite">—</span>;
  return (
    <ul className={cn("flex flex-col gap-1 text-caption", WRAP)}>
      {notes.map((note, index) => (
        <li key={index} className="flex items-start gap-1.5">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-signal-orange" aria-hidden="true" />
          <span>{note}</span>
        </li>
      ))}
    </ul>
  );
}

export function CatalogImportItemsTable({
  previewId,
  kind,
  selection,
  onSelectionChange,
  aliasOptIn,
  onAliasOptInChange,
  eligibleTotal,
  onPreviewGone,
  disabled = false,
}: Props) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<ImportItemClassification | undefined>(undefined);
  const [sort, setSort] = useState<CatalogImportSort>("label");
  const appliedSearch = useRef("");

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = search.trim();
      // Só volta à 1ª página se o termo realmente mudou (não ao montar).
      if (next === appliedSearch.current) return;
      appliedSearch.current = next;
      setDebouncedSearch(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const query = useQuery({
    queryKey: ["catalog-import-items", previewId, page, status, debouncedSearch, sort],
    queryFn: () =>
      getCatalogImportItems(previewId, {
        page,
        page_size: PAGE_SIZE,
        status,
        search: debouncedSearch || undefined,
        sort,
      }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });

  const gone = query.isError && isPreviewGone(query.error);
  useEffect(() => {
    if (gone) onPreviewGone();
  }, [gone, onPreviewGone]);

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const filtered = status !== undefined || debouncedSearch !== "";
  const busy = query.isFetching && !query.isPending;
  const selectedOnPage = items.filter((item) => isItemSelected(item, selection)).length;
  const eligibleOnPage = items.filter((item) => isEligible(item.classification)).length;
  const aliasCapable = (item: CatalogImportItem) =>
    kind === "units" && isEligible(item.classification) && item.details?.create_alias === true;
  // Itens desta página que o ADM marcou para importação E que admitem sigla.
  const aliasCandidates = items.filter((item) => aliasCapable(item) && isItemSelected(item, selection));
  const aliasOptedOnPage = aliasCandidates.filter((item) => aliasOptIn[item.id]).length;
  const aliasTotalOpted = Object.values(aliasOptIn).filter(Boolean).length;
  const noun = CATALOG_KIND_LABEL[kind].plural;
  const pageKey = `${query.data?.page ?? page}|${status ?? ""}|${debouncedSearch}|${sort}`;
  const columns = 7;

  function chooseStatus(next: ImportItemClassification | undefined) {
    setStatus(next);
    setPage(1);
  }

  function chooseSort(next: CatalogImportSort) {
    setSort(next);
    setPage(1);
  }

  return (
    <section aria-labelledby={`catalog-items-title-${kind}`} className="flex min-w-0 flex-col gap-4">
      <h2 id={`catalog-items-title-${kind}`} className="text-eyebrow text-pale-stone">
        Itens da prévia
      </h2>

      <div className="flex flex-col gap-4">
        <div className="relative w-full md:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={`Buscar ${noun} na prévia`}
            placeholder="Buscar por nome ou ID de origem…"
            maxLength={SEARCH_MAX}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por classificação">
            <FilterPill label="Todos" active={status === undefined} onClick={() => chooseStatus(undefined)} />
            {CLASSIFICATIONS.map((key) => (
              <FilterPill
                key={key}
                label={CLASSIFICATION_META[key].label}
                active={status === key}
                onClick={() => chooseStatus(key)}
              />
            ))}
          </div>
          {filtered ? (
            <Button
              variant="link"
              size="sm"
              className="min-h-8"
              onClick={() => {
                setSearch("");
                appliedSearch.current = "";
                setDebouncedSearch("");
                chooseStatus(undefined);
              }}
            >
              Limpar filtros
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || eligibleTotal === 0}
            onClick={() => onSelectionChange({ base: "all", overrides: {} })}
          >
            Selecionar todos os elegíveis ({eligibleTotal})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onSelectionChange({ base: "none", overrides: {} })}
          >
            Limpar seleção
          </Button>
          <span className="text-caption text-pale-stone" aria-live="polite" data-testid="selection-page-count">
            Nesta página: {selectedOnPage} de {eligibleOnPage} elegível(is) selecionado(s)
          </span>
        </div>
        {kind === "units" ? (
          <div className="flex flex-col gap-3 border border-ash-stroke p-4 rounded-sm" data-testid="alias-optin-panel">
            <p id={ALIAS_HELP_ID} className="text-body-sm text-pale-stone">
              Sigla de atalho: nenhuma sigla é criada por padrão. Ao aceitar, a sigla passa a decidir a unidade dos
              bens importados — marque só as que você conferiu.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || aliasCandidates.length === 0}
                onClick={() => {
                  const next = { ...aliasOptIn };
                  for (const item of aliasCandidates) next[item.id] = true;
                  onAliasOptInChange(next);
                }}
              >
                Criar sigla nos itens selecionados desta página ({aliasCandidates.length})
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || aliasTotalOpted === 0}
                onClick={() => onAliasOptInChange({})}
              >
                Limpar siglas marcadas
              </Button>
              <span className="text-caption text-pale-stone" aria-live="polite" data-testid="alias-optin-count">
                Siglas marcadas: {aliasTotalOpted} (nesta página: {aliasOptedOnPage})
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {query.isError && !gone ? (
        <CatalogNotice onRetry={() => void query.refetch()} retrying={query.isFetching}>
          {catalogImportErrorMessage(query.error, "items")}
        </CatalogNotice>
      ) : null}

      {query.isPending ? (
        <LoadingSkeleton variant="table" count={5} columns={5} label="Carregando itens da prévia…" />
      ) : query.data ? (
        <>
          <Table busy={busy} aria-label={`Itens da prévia de ${noun}`}>
            <TableHeader>
              <TableRow className="hover:bg-transparent focus-within:bg-transparent">
                <TableHead>Sel.</TableHead>
                <TableHead>Linha</TableHead>
                <SortableHead field="source_id" label="ID de origem" sort={sort} onSortChange={chooseSort} />
                <SortableHead field="label" label="Nome" sort={sort} onSortChange={chooseSort} />
                <TableHead>Detalhes</TableHead>
                <SortableHead field="classification" label="Classificação" sort={sort} onSortChange={chooseSort} />
                <TableHead>Avisos</TableHead>
              </TableRow>
            </TableHeader>
            <AnimatedTableBody key={pageKey} limit={PAGE_SIZE}>
              {items.length === 0 ? (
                <TableEmpty
                  colSpan={columns}
                  icon={SearchX}
                  title="Nenhum item encontrado para os filtros atuais."
                  description="Ajuste a busca ou escolha outra classificação."
                />
              ) : (
                items.map((item, index) => {
                  const eligible = isEligible(item.classification);
                  const checked = isItemSelected(item, selection);
                  const meta = CLASSIFICATION_META[item.classification];
                  const Icon = meta.icon;
                  const reason = eligible ? undefined : ineligibleReason(item.classification, item.validation_errors);
                  const name = item.label || `linha ${item.row ?? "?"}`;
                  return (
                    <AnimatedTableRow key={item.id} index={index} data-state={checked ? "selected" : undefined}>
                      <TableCell>
                        {/* Rótulo de 24x24 amplia a área de toque (WCAG 2.5.8). */}
                        <label className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm transition-factory hover:bg-carbon-lift has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!eligible || disabled}
                            onChange={() => onSelectionChange(toggleItem(item, selection))}
                            title={reason}
                            aria-label={eligible ? `Selecionar ${name}` : (reason ?? `Item ${name} não selecionável`)}
                            className="h-4 w-4 cursor-pointer rounded-sm border border-ash-stroke bg-carbon-lift accent-metric-green disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </label>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-warm-granite">{item.row ?? "—"}</TableCell>
                      <TableCell className={cn("min-w-[7rem] font-mono", WRAP)}>{item.source_record_id ?? "—"}</TableCell>
                      <TableCell className={cn("min-w-[12rem]", WRAP)}>{item.label ?? "—"}</TableCell>
                      <TableCell className="min-w-[12rem]">
                        <Detail
                          item={item}
                          kind={kind}
                          alias={
                            aliasCapable(item)
                              ? {
                                  checked: checked && !!aliasOptIn[item.id],
                                  disabled: disabled || !checked,
                                  onChange: () =>
                                    onAliasOptInChange({ ...aliasOptIn, [item.id]: !aliasOptIn[item.id] }),
                                }
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {/* Ícone + texto: a cor nunca é o único sinal (WCAG 1.4.1). */}
                        <Badge variant={meta.badge} className="whitespace-nowrap">
                          <Icon aria-hidden="true" />
                          {meta.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-[12rem]">
                        <Warnings item={item} />
                      </TableCell>
                    </AnimatedTableRow>
                  );
                })
              )}
            </AnimatedTableBody>
          </Table>
          <CatalogPagination
            page={query.data.page}
            total={total}
            pageSize={PAGE_SIZE}
            noun="item(ns)"
            loading={query.isPlaceholderData}
            onPage={setPage}
          />
        </>
      ) : null}
    </section>
  );
}
