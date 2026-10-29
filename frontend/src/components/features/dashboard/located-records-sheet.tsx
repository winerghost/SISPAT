"use client";

import { useId, useState } from "react";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CATEGORY_OPTIONS, type PanelFilters } from "@/lib/dashboard-equipment-api";
import {
  LOCATED_LABEL,
  LOCATED_VALUES,
  OTHERS_UNIT,
  isLocatedSort,
  isLocatedUnavailable,
  isLocatedValue,
  useLocatedRecords,
  type LocatedRecord,
  type LocatedSort,
  type LocatedValue,
} from "@/lib/dashboard-located-api";
import { DEFAULT_PAGE_SIZE, parsePageSize } from "@/lib/pagination";
import { cn } from "@/lib/utils";

// =============================================================================
// Registros por trás de uma barra do painel `located_by_unit_chart`.
// Painel lateral (Sheet = Radix Dialog): foco preso, Esc fecha, foco devolvido
// ao botão de origem (ver located-chart-view). Somente leitura: patrimônio,
// descrição, unidade, sala, situação e categoria. NENHUM dado pessoal é pedido
// nem exibido. Os textos vêm do backend e só passam pelo escape do React.
//
// Escolhas:
//  - Clique numa série filtra por `located`; o seletor "Situação" permite ver
//    TODAS as situações da unidade (o parâmetro `located` deixa de ser enviado).
//  - "Outras" (`unit` = "outras"): o backend reconstrói o conjunto; o cliente
//    manda só familia/categoria do painel, nunca o filtro de unidade do painel.
//  - Detalhe do bem: NÃO há rota de detalhe de patrimônio para os perfis
//    USER/RH (a tela /patrimonios é uma lista), então os registros só são listados.
//  - Mensagens fixas (nunca o texto do servidor). 404 = indisponível ao perfil.
//  - Tabela a partir de `lg`; abaixo, cartões. Rolagem só dentro do painel.
// =============================================================================

export interface LocatedTarget {
  /** Incrementa a cada abertura (reinicia a página). */
  session: number;
  /** UUID da unidade ou "outras". */
  unit: string;
  /** Rótulo da unidade, como veio do backend. */
  unidade: string;
  /** `null` = todas as situações. */
  located: LocatedValue | null;
}

const SORT_LABEL: Record<LocatedSort, string> = {
  patrimony_number: "Nº patrimonial (crescente)",
  "-patrimony_number": "Nº patrimonial (decrescente)",
  description: "Descrição (A–Z)",
  "-description": "Descrição (Z–A)",
  located: "Situação (A–Z)",
  "-located": "Situação (Z–A)",
};
const SORT_ORDER: readonly LocatedSort[] = [
  "patrimony_number",
  "-patrimony_number",
  "description",
  "-description",
  "located",
  "-located",
];

const ERROR_MESSAGE = "Não foi possível carregar os bens desta seleção. Nenhum valor foi estimado.";
const UNAVAILABLE_MESSAGE = "Esta lista não está disponível para o seu perfil.";

export const ALL_SITUATIONS_LABEL = "Todas as situações";

const categoryLabel = (id: string | null) =>
  id === null ? "Não classificado" : (CATEGORY_OPTIONS.find((c) => c.id === id)?.label ?? id);

export interface LocatedRecordsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: LocatedTarget | null;
  /** Só família e categoria do painel (o `unit_id` do painel nunca é repassado). */
  filters: Pick<PanelFilters, "familia" | "categoria">;
  /** Rótulos das séries enviados pelo backend (fallback: rótulos padrão). */
  labels: Partial<Record<LocatedValue, string>>;
  onLocatedChange: (located: LocatedValue | null) => void;
}

export function LocatedRecordsSheet({ open, onOpenChange, target, filters, labels, onLocatedChange }: LocatedRecordsSheetProps) {
  const labelOf = (value: LocatedValue) => labels[value] ?? LOCATED_LABEL[value];
  const title = target ? `${target.located ? labelOf(target.located) : ALL_SITUATIONS_LABEL} — ${target.unidade}` : "Bens";
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        target?.unit === OTHERS_UNIT
          ? "Soma das unidades fora das de maior volume. Lista somente de leitura, no escopo do seu perfil."
          : "Lista somente de leitura, no escopo do seu perfil."
      }
      className="max-w-5xl"
    >
      {open && target ? (
        <RecordsBody
          key={target.session}
          target={target}
          filters={filters}
          labelOf={labelOf}
          onLocatedChange={onLocatedChange}
        />
      ) : null}
    </Sheet>
  );
}

function RecordsBody({
  target,
  filters,
  labelOf,
  onLocatedChange,
}: {
  target: LocatedTarget;
  filters: Pick<PanelFilters, "familia" | "categoria">;
  labelOf: (value: LocatedValue) => string;
  onLocatedChange: (located: LocatedValue | null) => void;
}) {
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<LocatedSort>("patrimony_number");
  const [pageState, setPageState] = useState({ scope: "", page: 1 });
  const situationId = `lc-sit-${useId().replace(/:/g, "")}`;
  const sortId = `lc-sort-${useId().replace(/:/g, "")}`;

  // A página volta a 1 sempre que a lista muda (situação, ordem ou tamanho), sem efeitos.
  const scope = `${target.located ?? ""}|${sort}|${pageSize}`;
  const page = pageState.scope === scope ? pageState.page : 1;

  const query = useLocatedRecords(
    {
      unit: target.unit,
      located: target.located,
      familia: filters.familia,
      categoria: filters.categoria,
      page,
      pageSize,
      sort,
    },
    true,
  );
  const data = query.data;
  const busy = query.isFetching;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-located-records>
      <form
        aria-label="Filtros da lista de bens"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={situationId} className="text-eyebrow text-pale-stone">
            Situação
          </label>
          <select
            id={situationId}
            value={target.located ?? ""}
            onChange={(event) => onLocatedChange(isLocatedValue(event.target.value) ? event.target.value : null)}
            className={cn(selectControlClassName, "min-w-0")}
          >
            <option value="">{ALL_SITUATIONS_LABEL}</option>
            {LOCATED_VALUES.map((value) => (
              <option key={value} value={value}>
                {labelOf(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={sortId} className="text-eyebrow text-pale-stone">
            Ordenar por
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(event) => {
              if (isLocatedSort(event.target.value)) setSort(event.target.value);
            }}
            className={cn(selectControlClassName, "min-w-0")}
          >
            {SORT_ORDER.map((value) => (
              <option key={value} value={value}>
                {SORT_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </form>

      {query.isPending ? (
        <LoadingSkeleton variant="table" count={6} columns={5} label="Carregando bens" />
      ) : query.isError && !data ? (
        <div role="alert" data-located-error className="flex flex-col items-start gap-3">
          <p className="flex items-start gap-2 text-body-sm text-bone">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            {isLocatedUnavailable(query.error) ? UNAVAILABLE_MESSAGE : ERROR_MESSAGE}
          </p>
          {isLocatedUnavailable(query.error) ? null : (
            <Button variant="ghost" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden="true" />
              Tentar novamente
            </Button>
          )}
        </div>
      ) : data && data.total === 0 ? (
        <div data-located-empty className="flex flex-col items-start gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-buttons border border-carbon-lift text-warm-granite">
            <BarChart3 className="h-4 w-4" aria-hidden="true" />
          </span>
          <p className="text-body text-bone">Nenhum bem nesta seleção</p>
          <p className="max-w-xl text-body-sm text-warm-granite">
            Não há bens ativos com esta situação nesta unidade, dentro do escopo do seu perfil. Escolha outra situação.
          </p>
        </div>
      ) : data ? (
        <div className="flex min-w-0 flex-col gap-4" aria-busy={busy || undefined}>
          <RecordsTable items={data.items} busy={busy} labelOf={labelOf} />
          <RecordsCards items={data.items} labelOf={labelOf} />
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={data.total}
            busy={busy}
            noun="bem(ns)"
            label="Paginação da lista de bens"
            onPageChange={(next) => setPageState({ scope, page: next })}
            onPageSizeChange={(size) => setPageSizeState(parsePageSize(size))}
          />
        </div>
      ) : null}
    </div>
  );
}

const situationText = (value: LocatedValue | null, labelOf: (v: LocatedValue) => string) =>
  value === null ? "Não informado" : labelOf(value);

function RecordsTable({
  items,
  busy,
  labelOf,
}: {
  items: LocatedRecord[];
  busy: boolean;
  labelOf: (value: LocatedValue) => string;
}) {
  return (
    <div className="hidden lg:block" data-located-table>
      <Table regionLabel="Bens da seleção (rolável)" busy={busy}>
        <caption className="sr-only">Bens da seleção</caption>
        <TableHeader>
          <TableRow>
            {["Patrimônio", "Descrição", "Unidade", "Sala", "Situação", "Categoria"].map((heading) => (
              <TableHead key={heading} scope="col">
                {heading}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id} data-located-row={item.id}>
              <th scope="row" className="px-4 py-[var(--density-cell-y)] text-left align-middle font-regular break-words text-bone">
                {item.patrimony_number}
              </th>
              <TableCell className="max-w-xs break-words [overflow-wrap:anywhere]">{item.description ?? "—"}</TableCell>
              <TableCell className="break-words [overflow-wrap:anywhere]">{item.unidade}</TableCell>
              <TableCell className="break-words [overflow-wrap:anywhere]">{item.sala ?? "—"}</TableCell>
              <TableCell>{situationText(item.located, labelOf)}</TableCell>
              <TableCell>{categoryLabel(item.equipment_category)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RecordsCards({ items, labelOf }: { items: LocatedRecord[]; labelOf: (value: LocatedValue) => string }) {
  return (
    <ul
      aria-label="Bens da seleção"
      data-located-cards
      className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:hidden"
    >
      {items.map((item) => (
        <li key={item.id} data-located-row={item.id} className="min-w-0 rounded-cards border border-carbon-lift p-3">
          <p className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">
            <span className="text-caption text-warm-granite">Patrimônio </span>
            {item.patrimony_number}
          </p>
          <p className="mt-1 break-words text-body-sm text-bone [overflow-wrap:anywhere]">{item.description ?? "—"}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {[
              ["Unidade", item.unidade],
              ["Sala", item.sala ?? "—"],
              ["Situação", situationText(item.located, labelOf)],
              ["Categoria", categoryLabel(item.equipment_category)],
            ].map(([term, value]) => (
              <div key={term} className="flex min-w-0 flex-col">
                <dt className="text-caption text-warm-granite">{term}</dt>
                <dd className="m-0 break-words text-body-sm text-bone [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
