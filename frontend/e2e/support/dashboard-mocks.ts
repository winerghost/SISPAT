// =============================================================================
// Mocks SINTÉTICOS de `/api/v1/dashboard/{resumo,por-unidade,por-situacao,
// aquisicoes-mensais}` — contrato em src/lib/dashboard-api.ts.
// =============================================================================
// Nenhum dado é real. `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE
// null no contrato. Sem dependência de `mocks.ts` (evita import circular): as
// respostas saem pelo callback `respond`.
// =============================================================================

export type DashboardEndpoint = "resumo" | "por-unidade" | "por-situacao" | "aquisicoes-mensais";

export interface DashboardSummaryMock {
  total_bens: number;
  localizados: number;
  nao_localizados: number;
  desconhecidos: number;
  movimentacoes_pendentes: number;
  inventarios_abertos: number;
  novos_30d: number;
  valor_total: number | null;
  em_manutencao: number | null;
  baixas_ano: number | null;
  variacao: {
    total_bens: number | null;
    valor_total: number | null;
    em_manutencao: number | null;
    baixas_ano: number | null;
  };
}

export interface DashboardMockData {
  resumo: DashboardSummaryMock;
  "por-unidade": { unidade: string; total: number; tipos: Record<string, number> }[];
  "por-situacao": { id: string; value: number }[];
  "aquisicoes-mensais": { id: string; data: { x: string; y: number }[] }[];
}

export const LONG_UNIT_NAME = "Unidade Sintética de Araguaína com Nome Bastante Longo para Teste de Quebra";

export function defaultDashboard(): DashboardMockData {
  return {
    resumo: {
      total_bens: 1234,
      localizados: 1100,
      nao_localizados: 90,
      desconhecidos: 44,
      movimentacoes_pendentes: 12,
      inventarios_abertos: 2,
      novos_30d: 37,
      valor_total: null,
      em_manutencao: null,
      baixas_ano: null,
      variacao: { total_bens: 3.5, valor_total: null, em_manutencao: null, baixas_ano: null },
    },
    "por-unidade": [
      {
        unidade: "Sede Sintética Palmas",
        total: 700,
        tipos: { MOBILIARIO: 400, INFORMATICA: 200, EQUIPAMENTO: 60, VEICULO: 25, OUTROS: 15 },
      },
      {
        unidade: "Unidade Sintética Gurupi",
        total: 400,
        tipos: { MOBILIARIO: 200, INFORMATICA: 150, EQUIPAMENTO: 30, VEICULO: 10, OUTROS: 10 },
      },
      {
        unidade: LONG_UNIT_NAME,
        total: 134,
        tipos: { MOBILIARIO: 60, INFORMATICA: 50, EQUIPAMENTO: 14, OUTROS: 10 },
      },
    ],
    "por-situacao": [
      { id: "LOCALIZADO", value: 1100 },
      { id: "NAO_LOCALIZADO", value: 90 },
      { id: "DESCONHECIDO", value: 44 },
    ],
    "aquisicoes-mensais": [
      {
        id: "novos_bens",
        data: [
          { x: "2026-05", y: 5 },
          { x: "2026-06", y: 12 },
          { x: "2026-07", y: 0 },
          { x: "2026-08", y: 8 },
          { x: "2026-09", y: 20 },
          { x: "2026-10", y: 37 },
        ],
      },
    ],
  };
}

/** Todos os endpoints vazios (sem bens). */
export function emptyDashboard(): DashboardMockData {
  const base = defaultDashboard();
  return {
    resumo: {
      ...base.resumo,
      total_bens: 0,
      localizados: 0,
      nao_localizados: 0,
      desconhecidos: 0,
      movimentacoes_pendentes: 0,
      inventarios_abertos: 0,
      novos_30d: 0,
      variacao: { ...base.resumo.variacao, total_bens: null },
    },
    "por-unidade": [],
    "por-situacao": [],
    "aquisicoes-mensais": [],
  };
}

const ROUTE_RE = /^\/v1\/dashboard\/(resumo|por-unidade|por-situacao|aquisicoes-mensais)$/;

export interface DashboardRequestContext {
  state: { dashboard: DashboardMockData; dashboardStatus: Partial<Record<DashboardEndpoint, number>> };
  method: string;
  path: string;
  respond: (status: number, payload: unknown) => Promise<void> | void;
}

/** Trata `GET /v1/dashboard/<endpoint>`. `true` = tratada. */
export async function handleDashboard(ctx: DashboardRequestContext): Promise<boolean> {
  const match = ctx.path.match(ROUTE_RE);
  if (!match || ctx.method !== "GET") return false;
  const endpoint = match[1] as DashboardEndpoint;
  const forced = ctx.state.dashboardStatus[endpoint];
  if (forced && forced >= 400) {
    await ctx.respond(forced, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
    return true;
  }
  await ctx.respond(200, ctx.state.dashboard[endpoint]);
  return true;
}
