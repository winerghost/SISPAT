// =============================================================================
// SISPAT-AGU — dashboard-located-api.ts
// =============================================================================
// Registros por trás do painel `located_by_unit_chart` (clique numa barra):
//
//   GET /v1/dashboard/panels/located_by_unit_chart/records
//       ?unit_id=<uuid|outras>&located=SIM|NAO|DESCONHECIDO&familia&categoria
//       &page&page_size(50|100|200)&sort(patrimony_number|description|located, "-" = desc)
//   -> {items:[{id,patrimony_number,description,unidade,sala,located,
//               equipment_category,classification_confidence}],
//       total, page, page_size, pages}
//
// Só transporte + validação por allowlist: resposta fora do formato é REJEITADA
// (a tela mostra erro). Os números e textos são os do backend; nada é somado ou
// estimado aqui. Quem pode ver o quê (perfil, unidade) é decisão do backend:
// 404 = painel indisponível ao perfil (mensagem neutra, sem tentar de novo).
//
// "Outras" (barra sem `unit_id`): `unit_id=outras`, repassando `familia` e
// `categoria` ativos do painel e NUNCA o filtro `unit_id` do painel.
// =============================================================================

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, apiClient } from "@/lib/api-client";
import { ContractError, noRetryOn4xx, type PanelFilters } from "@/lib/dashboard-equipment-api";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === "string";

export const LOCATED_PANEL_ID = "located_by_unit_chart";
export const OTHERS_UNIT = "outras";

export const LOCATED_VALUES = ["SIM", "NAO", "DESCONHECIDO"] as const;
export type LocatedValue = (typeof LOCATED_VALUES)[number];
export const isLocatedValue = (v: unknown): v is LocatedValue =>
  typeof v === "string" && (LOCATED_VALUES as readonly string[]).includes(v);

/** Rótulos de apresentação (fallback; o gráfico usa os rótulos que o backend enviar). */
export const LOCATED_LABEL: Record<LocatedValue, string> = {
  SIM: "Localizados",
  NAO: "Não localizados",
  DESCONHECIDO: "Não informado",
};

export const LOCATED_SORT_VALUES = [
  "patrimony_number",
  "-patrimony_number",
  "description",
  "-description",
  "located",
  "-located",
] as const;
export type LocatedSort = (typeof LOCATED_SORT_VALUES)[number];
export const isLocatedSort = (v: string): v is LocatedSort => (LOCATED_SORT_VALUES as readonly string[]).includes(v);

export interface LocatedRecord {
  id: string;
  patrimony_number: string;
  description: string | null;
  unidade: string;
  sala: string | null;
  located: LocatedValue | null;
  equipment_category: string | null;
  classification_confidence: string | null;
}

export interface LocatedRecordsPage {
  items: LocatedRecord[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface LocatedRecordsParams {
  /** UUID da unidade ou `OTHERS_UNIT`. */
  unit: string;
  /** `null` = todas as situações (o parâmetro não é enviado). */
  located: LocatedValue | null;
  /** Só `familia` e `categoria` do painel: o `unit_id` do painel NUNCA vai junto. */
  familia?: PanelFilters["familia"];
  categoria?: string;
  page: number;
  pageSize: number;
  sort: LocatedSort;
}

const isRecord = (v: unknown): v is LocatedRecord =>
  isRec(v) &&
  isStr(v.id) &&
  isStr(v.patrimony_number) &&
  isNullableStr(v.description) &&
  isStr(v.unidade) &&
  isNullableStr(v.sala) &&
  (v.located === null || isLocatedValue(v.located)) &&
  isNullableStr(v.equipment_category) &&
  isNullableStr(v.classification_confidence);

export function parseLocatedRecords(raw: unknown): LocatedRecordsPage {
  if (
    !isRec(raw) ||
    !Array.isArray(raw.items) ||
    !raw.items.every(isRecord) ||
    !isInt(raw.total) ||
    !isInt(raw.page) ||
    !isInt(raw.page_size) ||
    !isInt(raw.pages)
  ) {
    throw new ContractError("registros do painel");
  }
  return {
    items: raw.items.map((item) => ({
      id: item.id,
      patrimony_number: item.patrimony_number,
      description: item.description,
      unidade: item.unidade,
      sala: item.sala,
      located: item.located,
      equipment_category: item.equipment_category,
      classification_confidence: item.classification_confidence,
    })),
    total: raw.total,
    page: raw.page,
    page_size: raw.page_size,
    pages: raw.pages,
  };
}

export function locatedRecordsSearchParams(params: LocatedRecordsParams): Record<string, string | number> {
  const search: Record<string, string | number> = {
    unit_id: params.unit,
    page: params.page,
    page_size: params.pageSize,
    sort: params.sort,
  };
  if (params.located) search.located = params.located;
  if (params.familia) search.familia = params.familia;
  if (params.categoria) search.categoria = params.categoria;
  return search;
}

export async function getLocatedRecords(params: LocatedRecordsParams): Promise<LocatedRecordsPage> {
  const raw = await apiClient.get<unknown>(`/v1/dashboard/panels/${LOCATED_PANEL_ID}/records`, {
    searchParams: locatedRecordsSearchParams(params),
  });
  return parseLocatedRecords(raw);
}

/** Chave sem página/tamanho/ordem: identifica "a mesma lista" (para manter a página anterior ao paginar). */
const scopeOf = (p: LocatedRecordsParams) =>
  ["dashboard", "located-records", p.unit, p.located ?? "", p.familia ?? "", p.categoria ?? ""] as const;
export const locatedRecordsKey = (p: LocatedRecordsParams) => [...scopeOf(p), p.page, p.pageSize, p.sort] as const;

export function useLocatedRecords(params: LocatedRecordsParams, enabled: boolean): UseQueryResult<LocatedRecordsPage, unknown> {
  const scope = scopeOf(params).join("|");
  return useQuery({
    queryKey: locatedRecordsKey(params),
    queryFn: () => getLocatedRecords(params),
    enabled,
    staleTime: 15_000,
    retry: noRetryOn4xx,
    // Mantém a página anterior só ao paginar/ordenar a MESMA lista; outra unidade ou situação nunca herda linhas alheias.
    placeholderData: (previous, previousQuery) =>
      previousQuery && previousQuery.queryKey.slice(0, 6).join("|") === scope ? previous : undefined,
  });
}

/** 404 = painel indisponível ao perfil (mensagem neutra, sem retry). */
export const isLocatedUnavailable = (error: unknown) => error instanceof ApiError && error.status === 404;
