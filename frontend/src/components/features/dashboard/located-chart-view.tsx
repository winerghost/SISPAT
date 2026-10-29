"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";

import { TOKENS } from "@/components/dashboard/chart-theme";
import type { SeriesStyle } from "@/components/dashboard/chart-shell";
import type { MultiSeriesChartData } from "@/components/dashboard/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import type { ChartData, PanelFilters, UnitRow } from "@/lib/dashboard-equipment-api";
import { OTHERS_UNIT, isLocatedValue, type LocatedValue } from "@/lib/dashboard-located-api";

import { formatCount } from "./equipment-format";
import { LocatedRecordsSheet, type LocatedTarget } from "./located-records-sheet";

// =============================================================================
// Painel `located_by_unit_chart`: barras agrupadas por unidade com 3 séries
// (Localizados, Não localizados, Não informado). Só apresentação: cada número é
// o do backend (nada é somado ou estimado, nada é animado).
//
// - Cor + textura + legenda + tabela de dados: a série nunca depende só de cor
//   (verde liso / laranja listrado / cinza pontilhado; verde e laranja são os
//   tokens funcionais do DESIGN.md, todos >= 3:1 sobre o canvas).
// - Clique numa barra abre a lista de bens (unidade + situação). O teclado usa
//   os botões da tabela "Bens por unidade e situação" (cada contagem é um botão
//   com foco visível, Enter/Espaço); o botão "Total" abre todas as situações.
// - Barra "Outras" (`unit_id` null) -> `unit_id=outras` no endpoint de registros.
// - Foco: antes de abrir o painel, o foco vai ao botão equivalente da tabela;
//   ao fechar (Esc/Fechar) volta a ele.
// =============================================================================

const GroupedBars = dynamic(
  () => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedGroupedBarChart),
  { ssr: false, loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" /> },
);

/** Cor semântica + textura por série (constante: a cor segue a entidade). */
const SERIES_STYLES: Readonly<Record<string, SeriesStyle>> = {
  SIM: { color: TOKENS.green, pattern: "solid" },
  NAO: { color: TOKENS.orange, pattern: "lines" },
  DESCONHECIDO: { color: TOKENS.granite, pattern: "dots" },
};

interface Row {
  key: string;
  index: number;
  unidade: string;
  total: number;
  valores: UnitRow["valores"];
  /** UUID, "outras" ou `null` quando o backend não informou o id (sem clique). */
  unit: string | null;
}

function toRows(dados: ChartData): Row[] {
  return dados.unidades.map((u, index) => ({
    key: `u${index}`,
    index,
    unidade: u.unidade,
    total: u.total,
    valores: u.valores,
    unit: u.unit_id === undefined ? null : (u.unit_id ?? OTHERS_UNIT),
  }));
}

function chartModel(dados: ChartData, rows: Row[]): MultiSeriesChartData {
  return {
    categories: rows.map((r) => ({ key: r.key, label: r.unidade })),
    series: dados.series.map((s) => ({
      key: s.id,
      label: s.label,
      values: Object.fromEntries(rows.map((r) => [r.key, r.valores[s.id]])),
    })),
  };
}

const cellKeyOf = (unit: string, located: LocatedValue | null) => `${unit}:${located ?? "ALL"}`;

const buttonClass =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-buttons border border-ash-stroke px-2 text-body-sm tabular-nums text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas";

function CountButton({
  count,
  unit,
  located,
  accessibleSuffix,
  onOpen,
}: {
  count: number;
  unit: string | null;
  located: LocatedValue | null;
  accessibleSuffix: string;
  onOpen: (located: LocatedValue | null) => void;
}) {
  // Sem bens (ou sem id de unidade) não há lista a abrir: só o número.
  if (count === 0 || unit === null) return <span className="tabular-nums text-bone">{formatCount(count)}</span>;
  return (
    <button type="button" data-located-cell={cellKeyOf(unit, located)} className={buttonClass} onClick={() => onOpen(located)}>
      {formatCount(count)}
      <span className="sr-only">{` ${accessibleSuffix}`}</span>
    </button>
  );
}

interface Column {
  id: string;
  label: string;
  located: LocatedValue;
}

function LocatedMatrix({
  rows,
  columns,
  caption,
  onOpen,
}: {
  rows: Row[];
  columns: Column[];
  caption: string;
  onOpen: (row: Row, located: LocatedValue | null) => void;
}) {
  const suffixOf = (row: Row, label: string | null) =>
    label ? `bens ${label} em ${row.unidade}: abrir lista` : `todos os bens de ${row.unidade}: abrir lista`;
  return (
    <div className="min-w-0" data-located-matrix>
      <div className="hidden lg:block">
        <Table regionLabel={`${caption} (rolável)`}>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Unidade</TableHead>
              <TableHead scope="col" className="text-right">
                Total
              </TableHead>
              {columns.map((column) => (
                <TableHead key={column.id} scope="col" className="text-right">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <th scope="row" className="px-4 py-[var(--density-cell-y)] text-left align-middle font-regular break-words text-bone">
                  {row.unidade}
                </th>
                <TableCell className="text-right">
                  <CountButton
                    count={row.total}
                    unit={row.unit}
                    located={null}
                    accessibleSuffix={suffixOf(row, null)}
                    onOpen={(located) => onOpen(row, located)}
                  />
                </TableCell>
                {columns.map((column) => (
                  <TableCell key={column.id} className="text-right">
                    <CountButton
                      count={row.valores[column.id] ?? 0}
                      unit={row.unit}
                      located={column.located}
                      accessibleSuffix={suffixOf(row, column.label)}
                      onOpen={(located) => onOpen(row, located)}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label={caption} className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:hidden">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 rounded-cards border border-carbon-lift p-3">
            <p className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">{row.unidade}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-col items-start gap-1">
                <dt className="text-caption text-warm-granite">Total</dt>
                <dd className="m-0">
                  <CountButton
                    count={row.total}
                    unit={row.unit}
                    located={null}
                    accessibleSuffix={suffixOf(row, null)}
                    onOpen={(located) => onOpen(row, located)}
                  />
                </dd>
              </div>
              {columns.map((column) => (
                <div key={column.id} className="flex min-w-0 flex-col items-start gap-1">
                  <dt className="text-caption text-warm-granite">{column.label}</dt>
                  <dd className="m-0">
                    <CountButton
                      count={row.valores[column.id] ?? 0}
                      unit={row.unit}
                      located={column.located}
                      accessibleSuffix={suffixOf(row, column.label)}
                      onOpen={(located) => onOpen(row, located)}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocatedChartView({ dados, label, filters }: { dados: ChartData; label: string; filters: PanelFilters }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(0);
  const returnKeyRef = useRef<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; target: LocatedTarget | null }>({ open: false, target: null });

  const rows = toRows(dados);
  const columns: Column[] = dados.series.flatMap((s) => (isLocatedValue(s.id) ? [{ id: s.id, label: s.label, located: s.id }] : []));
  const labels: Partial<Record<LocatedValue, string>> = Object.fromEntries(columns.map((c) => [c.located, c.label]));

  /** Foca o botão VISÍVEL (tabela >= lg, cartões < lg) daquela unidade + situação. */
  const focusCell = (key: string | null) => {
    if (!key) return;
    const candidates = containerRef.current?.querySelectorAll<HTMLElement>("[data-located-cell]") ?? [];
    for (const el of Array.from(candidates)) {
      if (el.dataset.locatedCell === key && el.getClientRects().length > 0) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  };

  const openFor = (row: Row, located: LocatedValue | null) => {
    if (row.unit === null) return;
    const key = cellKeyOf(row.unit, located);
    returnKeyRef.current = key;
    // O foco vai ao botão equivalente ANTES de abrir: é para ele que o painel devolve o foco ao fechar.
    focusCell(key);
    sessionRef.current += 1;
    setSheet({ open: true, target: { session: sessionRef.current, unit: row.unit, unidade: row.unidade, located } });
  };

  const onOpenChange = (open: boolean) => {
    setSheet((current) => ({ ...current, open }));
    if (!open) {
      // Reforço do retorno de foco (clique em barra não deixa um gatilho focado).
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusCell(returnKeyRef.current);
      }, 320);
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-3" data-located-chart>
      <GroupedBars
        title={`${label}: ${dados.familia_label}`}
        description="Até 15 unidades; as demais somadas em “Outras”."
        data={chartModel(dados, rows)}
        valueFormatter={formatCount}
        className="border-0 p-0"
        seriesStyles={SERIES_STYLES}
        onMarkClick={(categoryKey, seriesKey) => {
          const row = rows.find((r) => r.key === categoryKey);
          if (row && isLocatedValue(seriesKey)) openFor(row, seriesKey);
        }}
      />
      <p className="text-body-sm text-warm-granite">Total exibido: {formatCount(dados.total)}</p>
      <p className="text-body-sm text-warm-granite" data-located-hint>
        Clique numa barra ou use os botões da tabela abaixo para ver os bens (somente leitura). O botão “Total” lista
        todas as situações da unidade.
      </p>
      <details open className="group rounded-cards border border-carbon-lift">
        <summary className="cursor-pointer rounded-cards px-3 py-2 text-body-sm text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone">
          Bens por unidade e situação
        </summary>
        <div className="p-3">
          <LocatedMatrix rows={rows} columns={columns} caption={`${label} (dados do gráfico)`} onOpen={openFor} />
        </div>
      </details>

      <LocatedRecordsSheet
        open={sheet.open}
        onOpenChange={onOpenChange}
        target={sheet.target}
        filters={{ familia: filters.familia, categoria: filters.categoria }}
        labels={labels}
        onLocatedChange={(located) =>
          setSheet((current) => (current.target ? { ...current, target: { ...current.target, located } } : current))
        }
      />
    </div>
  );
}
