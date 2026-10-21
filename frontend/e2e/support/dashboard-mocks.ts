// =============================================================================
// Mocks SINTÉTICOS de `/api/v1/dashboard/*` (resumo, por-unidade, por-situacao,
// aquisicoes-mensais, localizacao-por-unidade, por-vinculo, pendencias-cadastro,
// por-sala, inventario, tipos) — contrato em src/lib/dashboard-api.ts e
// docs/architecture/dashboard-api.md.
// =============================================================================
// Nenhum dado é real. `valor_total`, `em_manutencao` e `baixas_ano` são SEMPRE
// null no contrato. Os FILTROS são validados como no backend (chave
// desconhecida, repetida, vazia ou inválida => 400; `meses` só no mensal) — um
// teste que envie lixo falha. Os números não mudam com o filtro (dados
// sintéticos), exceto `resumo.filtros_aplicados`, que espelha os NOMES
// recebidos. Sem dependência de `mocks.ts` (evita import circular).
// =============================================================================

export type DashboardEndpoint =
  | "resumo"
  | "por-unidade"
  | "por-situacao"
  | "aquisicoes-mensais"
  | "localizacao-por-unidade"
  | "por-vinculo"
  | "pendencias-cadastro"
  | "por-sala"
  | "inventario"
  | "tipos";

export const DASHBOARD_ENDPOINTS: readonly DashboardEndpoint[] = [
  "resumo",
  "por-unidade",
  "por-situacao",
  "aquisicoes-mensais",
  "localizacao-por-unidade",
  "por-vinculo",
  "pendencias-cadastro",
  "por-sala",
  "inventario",
  "tipos",
];

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
  filtros_aplicados?: string[];
}

export interface LabeledCountMock {
  id: string;
  label: string;
  value: number;
}

export interface DashboardMockData {
  resumo: DashboardSummaryMock;
  "por-unidade": { unidade: string; total: number; tipos: Record<string, number> }[];
  "por-situacao": { id: string; value: number }[];
  "aquisicoes-mensais": { id: string; data: { x: string; y: number }[] }[];
  "localizacao-por-unidade": { unidade: string; sim: number; nao: number; desconhecido: number; total: number }[];
  "por-vinculo": LabeledCountMock[];
  "pendencias-cadastro": { sem_responsavel: number; sem_sala: number; ociosos: number; nao_localizados: number };
  "por-sala": LabeledCountMock[];
  inventario: { conferidos: number; nao_conferidos: number; encontrados: number; nao_encontrados: number };
  tipos: { value: string; count: number }[];
}

export const LONG_UNIT_NAME = "Unidade Sintética de Araguaína com Nome Bastante Longo para Teste de Quebra";
/** Sala sintética do gráfico "Bens por sala" (UUID usável em `room_id=`). */
export const DASH_ROOM_ID = "80000000-0000-4000-8000-0000000000d1";

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
      filtros_aplicados: [],
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
    "localizacao-por-unidade": [
      { unidade: "Sede Sintética Palmas", sim: 620, nao: 50, desconhecido: 30, total: 700 },
      { unidade: "Unidade Sintética Gurupi", sim: 360, nao: 30, desconhecido: 10, total: 400 },
      { unidade: LONG_UNIT_NAME, sim: 120, nao: 10, desconhecido: 4, total: 134 },
    ],
    "por-vinculo": [
      { id: "Servidor", label: "Servidor", value: 800 },
      { id: "Ocioso", label: "Ocioso", value: 200 },
      { id: "Terceirizado", label: "Terceirizado", value: 150 },
      { id: "__none__", label: "Sem vínculo", value: 84 },
    ],
    "pendencias-cadastro": { sem_responsavel: 140, sem_sala: 84, ociosos: 200, nao_localizados: 90 },
    "por-sala": [
      { id: DASH_ROOM_ID, label: "Recepção Sintética", value: 300 },
      { id: "80000000-0000-4000-8000-0000000000d2", label: "Sala 101 Sintética (PSU-TO)", value: 250 },
      { id: "__outras__", label: "Outras", value: 600 },
      { id: "__none__", label: "Sem sala", value: 84 },
    ],
    inventario: { conferidos: 900, nao_conferidos: 334, encontrados: 860, nao_encontrados: 30 },
    tipos: [
      { value: "MOBILIARIO", count: 660 },
      { value: "INFORMATICA", count: 400 },
      { value: "EQUIPAMENTO", count: 104 },
      { value: "VEICULO", count: 35 },
      { value: "NAO_CLASSIFICADO", count: 35 },
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
    "localizacao-por-unidade": [],
    "por-vinculo": [],
    "pendencias-cadastro": { sem_responsavel: 0, sem_sala: 0, ociosos: 0, nao_localizados: 0 },
    "por-sala": [],
    inventario: { conferidos: 0, nao_conferidos: 0, encontrados: 0, nao_encontrados: 0 },
    tipos: [],
  };
}

/** Blocos com estado vazio quando TODOS os endpoints vêm vazios (pendências/inventário mostram zeros). */
export const EMPTY_BLOCKS = 7;
/** Blocos que mostram erro quando TODOS os endpoints falham (por-unidade alimenta 2 blocos; tipos não é bloco). */
export const ERROR_BLOCKS = 10;
/** Cartões de indicador do bloco "Indicadores". */
export const KPI_CARDS = 5;

// -----------------------------------------------------------------------------
// Validação dos filtros (espelho do backend: docs/architecture/dashboard-api.md)
// -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOL = ["true", "false"];

export const FILTER_RULES: Record<string, (value: string) => boolean> = {
  unit_id: (v) => UUID_RE.test(v),
  owner_unit_id: (v) => UUID_RE.test(v),
  room_id: (v) => UUID_RE.test(v),
  responsible_person_id: (v) => UUID_RE.test(v),
  has_room: (v) => BOOL.includes(v),
  has_responsible: (v) => BOOL.includes(v),
  located: (v) => ["SIM", "NAO", "DESCONHECIDO"].includes(v),
  // eslint-disable-next-line no-control-regex
  bond_status: (v) => v.trim().length > 0 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v),
  tipo: (v) => /^(?:[A-Z0-9]{1,40}|NAO_CLASSIFICADO)$/.test(v) && v !== "OUTROS",
  registrado_desde: (v) => DATE_RE.test(v),
  registrado_ate: (v) => DATE_RE.test(v),
  inventario: (v) => ["conferido", "nao_conferido", "encontrado", "nao_encontrado"].includes(v),
  movimentacao_pendente: (v) => BOOL.includes(v),
};

const FILTER_ORDER = Object.keys(FILTER_RULES);

/** `null` = válido; senão, os nomes inválidos (o backend nunca ecoa valores). */
function invalidParams(endpoint: DashboardEndpoint, query: URLSearchParams): string[] | null {
  const bad = new Set<string>();
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    const value = values[0] ?? "";
    if (key === "meses" && endpoint === "aquisicoes-mensais") {
      const n = Number(value);
      if (values.length !== 1 || !Number.isInteger(n) || n < 1 || n > 24) bad.add(key);
      continue;
    }
    const rule = FILTER_RULES[key];
    if (!rule || values.length !== 1 || value === "" || !rule(value)) bad.add(key);
  }
  const desde = query.get("registrado_desde");
  const ate = query.get("registrado_ate");
  if (desde && ate && desde > ate) bad.add("registrado_ate");
  return bad.size > 0 ? [...bad] : null;
}

// -----------------------------------------------------------------------------
// Roteamento
// -----------------------------------------------------------------------------

const ROUTE_RE = new RegExp(`^/v1/dashboard/(${DASHBOARD_ENDPOINTS.join("|")})$`);

export interface DashboardRequestContext {
  state: { dashboard: DashboardMockData; dashboardStatus: Partial<Record<DashboardEndpoint, number>> };
  method: string;
  path: string;
  /** Query string recebida (filtros). */
  query?: URLSearchParams;
  respond: (status: number, payload: unknown) => Promise<void> | void;
}

/** Trata `GET /v1/dashboard/<endpoint>`. `true` = tratada. */
export async function handleDashboard(ctx: DashboardRequestContext): Promise<boolean> {
  const match = ctx.path.match(ROUTE_RE);
  if (!match || ctx.method !== "GET") return false;
  const endpoint = match[1] as DashboardEndpoint;
  const query = ctx.query ?? new URLSearchParams();
  const invalid = invalidParams(endpoint, query);
  if (invalid) {
    await ctx.respond(400, {
      error: { code: "validation_error", message: `Parâmetro(s) inválido(s): ${invalid.join(", ")}.` },
    });
    return true;
  }
  const forced = ctx.state.dashboardStatus[endpoint];
  if (forced && forced >= 400) {
    await ctx.respond(forced, { error: { code: "INTERNAL", message: "SISPAT_BACKEND_MSG" } });
    return true;
  }
  if (endpoint === "resumo") {
    const applied = FILTER_ORDER.filter((name) => query.has(name));
    await ctx.respond(200, { ...ctx.state.dashboard.resumo, filtros_aplicados: applied });
    return true;
  }
  await ctx.respond(200, ctx.state.dashboard[endpoint]);
  return true;
}
