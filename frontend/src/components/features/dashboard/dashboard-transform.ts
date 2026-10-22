// =============================================================================
// Transformações PURAS dos dados do dashboard para os gráficos/tabela.
// Só reorganizam e rotulam números do backend — nenhuma estimativa, nenhum
// preenchimento de lacunas, nenhum arredondamento.
// =============================================================================

import type { ChartDatum, MultiSeriesChartData } from "@/components/dashboard/types";
import type {
  LabeledCount,
  MonthlySeries,
  SituationSlice,
  UnitBreakdownRow,
  UnitLocationRow,
} from "@/lib/dashboard-api";

/** Número máximo de séries por tipo; excedentes são somados em "Outros". */
export const MAX_TYPE_SERIES = 4;
export const OTHERS_SERIES_KEY = "__outros__";

/** "NAO_LOCALIZADO" → "Nao localizado" (rótulo legível; o id original é a chave). */
export function humanizeCode(code: string): string {
  const text = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : code;
}

const monthFormatter = new Intl.DateTimeFormat("pt-BR", {
  month: "short",
  year: "2-digit",
  timeZone: "America/Araguaina",
});

/** "2026-10" → "out. de 26" (mês de calendário; meio do mês evita virada de fuso). */
export function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month) return yearMonth;
  return monthFormatter.format(new Date(Date.UTC(year, month - 1, 15, 12)));
}

export interface TypeSeries {
  key: string;
  label: string;
}

/** Tipos ordenados por total (maior primeiro); do 5º em diante vira "Outros". */
export function buildTypeSeries(
  rows: UnitBreakdownRow[],
  labelOf: (tipo: string) => string = humanizeCode,
): { series: TypeSeries[]; hasOthers: boolean; head: string[] } {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const [tipo, count] of Object.entries(row.tipos)) totals.set(tipo, (totals.get(tipo) ?? 0) + count);
  }
  const ordered = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
    .map(([tipo]) => tipo);
  const hasOthers = ordered.length > MAX_TYPE_SERIES;
  const head = hasOthers ? ordered.slice(0, MAX_TYPE_SERIES - 1) : ordered;
  const series: TypeSeries[] = head.map((tipo) => ({ key: tipo, label: labelOf(tipo) }));
  if (hasOthers) {
    series.push({ key: OTHERS_SERIES_KEY, label: `Outros (${ordered.length - head.length})` });
  }
  return { series, hasOthers, head };
}

/** Valor de uma unidade para uma série (inclui a soma de "Outros"). */
export function seriesValue(row: UnitBreakdownRow, seriesKey: string, head: string[]): number {
  if (seriesKey !== OTHERS_SERIES_KEY) return row.tipos[seriesKey] ?? 0;
  return Object.entries(row.tipos)
    .filter(([tipo]) => !head.includes(tipo))
    .reduce((sum, [, count]) => sum + count, 0);
}

export interface UnitModel {
  chart: MultiSeriesChartData;
  series: TypeSeries[];
  head: string[];
}

/** `labelOf`: chaves já rotuladas pelo backend (Tecnologia) usam `(k) => k`. */
export function buildUnitModel(rows: UnitBreakdownRow[], labelOf: (tipo: string) => string = humanizeCode): UnitModel {
  const { series, head } = buildTypeSeries(rows, labelOf);
  const categories = rows.map((row, i) => ({ key: `u${i}`, label: row.unidade }));
  return {
    series,
    head,
    chart: {
      categories,
      series: series.map((s) => ({
        key: s.key,
        label: s.label,
        values: Object.fromEntries(rows.map((row, i) => [`u${i}`, seriesValue(row, s.key, head)])),
      })),
    },
  };
}

export function buildSituationData(slices: SituationSlice[]): ChartDatum[] {
  return slices
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id, "pt-BR"))
    .map((slice) => ({ key: slice.id, label: humanizeCode(slice.id), value: slice.value }));
}

export function buildMonthlyData(series: MonthlySeries[]): MultiSeriesChartData {
  const months = [...new Set(series.flatMap((s) => s.data.map((p) => p.x)))].sort();
  return {
    categories: months.map((x) => ({ key: x, label: formatMonth(x) })),
    series: series.map((s) => ({
      key: s.id,
      label: humanizeCode(s.id),
      values: Object.fromEntries(s.data.map((p) => [p.x, p.y])),
    })),
  };
}

/**
 * Localizados × não localizados por unidade (barras empilhadas). Ordem das
 * séries = ordem das cores (fixa): Não localizado (sinal), Localizado,
 * Desconhecido. Chaves das categorias são internas (u0, u1...), nunca o texto.
 */
export const LOCATION_SERIES = [
  { key: "nao", label: "Não localizado" },
  { key: "sim", label: "Localizado" },
  { key: "desconhecido", label: "Desconhecido" },
] as const;

export function buildUnitLocationData(rows: UnitLocationRow[]): MultiSeriesChartData {
  return {
    categories: rows.map((row, i) => ({ key: `u${i}`, label: row.unidade })),
    series: LOCATION_SERIES.map((s) => ({
      key: s.key,
      label: s.label,
      values: Object.fromEntries(rows.map((row, i) => [`u${i}`, row[s.key]])),
    })),
  };
}

/** Vínculo/sala → categorias (ordem do backend: top N, "Outros", "Sem ..."). */
export function buildLabeledData(items: LabeledCount[]): ChartDatum[] {
  return items.filter((item) => item.value > 0).map((item) => ({ key: item.id, label: item.label, value: item.value }));
}

/** Bens por sala em barras horizontais (série única "Bens"). */
export function buildRoomData(items: LabeledCount[]): MultiSeriesChartData {
  const rows = items.filter((item) => item.value > 0);
  return {
    categories: rows.map((item, i) => ({ key: `r${i}`, label: item.label })),
    series: [{ key: "bens", label: "Bens", values: Object.fromEntries(rows.map((item, i) => [`r${i}`, item.value])) }],
  };
}
