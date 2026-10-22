// =============================================================================
// Mocks SINTÉTICOS de `/api/v1/dashboard/*` (resumo, por-unidade, por-situacao,
// aquisicoes-mensais, localizacao-por-unidade, por-vinculo, pendencias-cadastro,
// por-sala, inventario, tipos e tecnologia/*) — contrato em src/lib/dashboard-api.ts e
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

/** Painéis de Tecnologia (`/v1/dashboard/tecnologia/<nome>`; `export` devolve arquivo). */
export type TechEndpoint =
  | "tecnologia/resumo"
  | "tecnologia/por-categoria"
  | "tecnologia/por-unidade"
  | "tecnologia/por-status"
  | "tecnologia/sem-responsavel"
  | "tecnologia/tempo-registro"
  | "tecnologia/export";

export const TECH_ENDPOINTS: readonly TechEndpoint[] = [
  "tecnologia/resumo",
  "tecnologia/por-categoria",
  "tecnologia/por-unidade",
  "tecnologia/por-status",
  "tecnologia/sem-responsavel",
  "tecnologia/tempo-registro",
  "tecnologia/export",
];

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

export interface TechCountMock {
  id: string;
  label: string;
  value: number;
}

export interface TechMockData {
  resumo: {
    total_bens: number;
    tecnologia: number;
    nao_classificados: number;
    tecnologia_sem_responsavel: number;
    tecnologia_sem_tipo: number;
    tecnologia_sem_status: number;
  };
  "por-categoria": { categorias: TechCountMock[]; tipos_ti: TechCountMock[] };
  "por-unidade": { unidade: string; total: number; tipos: Record<string, number> }[];
  "por-status": TechCountMock[];
  "sem-responsavel": {
    tecnologia: number;
    sem_responsavel: number;
    percentual: number | null;
    por_unidade: { unidade: string; value: number }[];
  };
  "tempo-registro": TechCountMock[];
}

export const LONG_UNIT_NAME = "Unidade Sintética de Araguaína com Nome Bastante Longo para Teste de Quebra";
/** Sala sintética do gráfico "Bens por sala" (UUID usável em `room_id=`). */
export const DASH_ROOM_ID = "80000000-0000-4000-8000-0000000000d1";

/** Dados sintéticos de Tecnologia (somas coerentes: 400 bens de TI em 1234 bens). */
export function defaultTech(): TechMockData {
  return {
    resumo: {
      total_bens: 1234,
      tecnologia: 400,
      nao_classificados: 120,
      tecnologia_sem_responsavel: 35,
      tecnologia_sem_tipo: 20,
      tecnologia_sem_status: 60,
    },
    "por-categoria": {
      categorias: [
        { id: "TECNOLOGIA", label: "Tecnologia", value: 400 },
        { id: "MOBILIARIO", label: "Mobiliário", value: 500 },
        { id: "VEICULO", label: "Veículo", value: 30 },
        { id: "EQUIPAMENTO", label: "Equipamento", value: 150 },
        { id: "OUTROS", label: "Outros", value: 34 },
        { id: "NAO_CLASSIFICADO", label: "Não classificado", value: 120 },
      ],
      tipos_ti: [
        { id: "COMPUTADOR", label: "Computador", value: 120 },
        { id: "NOTEBOOK", label: "Notebook", value: 150 },
        { id: "MONITOR", label: "Monitor", value: 80 },
        { id: "IMPRESSORA", label: "Impressora", value: 20 },
        { id: "OUTRO_TI", label: "Outro item de TI", value: 10 },
        { id: "NAO_INFORMADO", label: "Tipo não informado", value: 20 },
      ],
    },
    "por-unidade": [
      {
        unidade: "Sede Sintética Palmas",
        total: 250,
        tipos: { Notebook: 100, Computador: 70, Monitor: 50, "Tipo não informado": 30 },
      },
      { unidade: "Unidade Sintética Gurupi", total: 100, tipos: { Notebook: 40, Computador: 30, Monitor: 20, Impressora: 10 } },
      { unidade: LONG_UNIT_NAME, total: 50, tipos: { Notebook: 10, Computador: 20, Monitor: 10, "Outro item de TI": 10 } },
    ],
    "por-status": [
      { id: "EM_USO", label: "Em uso", value: 250 },
      { id: "ESTOQUE", label: "Em estoque", value: 40 },
      { id: "MANUTENCAO", label: "Em manutenção", value: 30 },
      { id: "BAIXADO", label: "Baixado", value: 20 },
      { id: "NAO_INFORMADO", label: "Não informado", value: 60 },
    ],
    "sem-responsavel": {
      tecnologia: 400,
      sem_responsavel: 35,
      percentual: 8.8,
      por_unidade: [
        { unidade: "Sede Sintética Palmas", value: 20 },
        { unidade: "Unidade Sintética Gurupi", value: 10 },
        { unidade: "Outras", value: 5 },
      ],
    },
    "tempo-registro": [
      { id: "ate_1_ano", label: "Até 1 ano", value: 60 },
      { id: "1_a_3_anos", label: "De 1 a 3 anos", value: 120 },
      { id: "3_a_5_anos", label: "De 3 a 5 anos", value: 110 },
      { id: "mais_de_5_anos", label: "Mais de 5 anos", value: 90 },
      { id: "sem_data", label: "Sem data de registro", value: 20 },
    ],
  };
}

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

/** Tecnologia sem bens classificados (zeros reais; listas vazias). */
export function emptyTech(): TechMockData {
  const base = defaultTech();
  return {
    resumo: { ...base.resumo, tecnologia: 0, nao_classificados: 0, tecnologia_sem_responsavel: 0, tecnologia_sem_tipo: 0, tecnologia_sem_status: 0, total_bens: 0 },
    "por-categoria": { categorias: [], tipos_ti: [] },
    "por-unidade": [],
    "por-status": [],
    "sem-responsavel": { tecnologia: 0, sem_responsavel: 0, percentual: null, por_unidade: [] },
    "tempo-registro": [],
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
export const EMPTY_BLOCKS = 7 + 5; // + 5 painéis de Tecnologia (o de indicadores mostra zeros)
/** Blocos que mostram erro quando TODOS os endpoints falham (por-unidade alimenta 2 blocos; tipos não é bloco). */
export const ERROR_BLOCKS = 10 + 6; // + 6 painéis de Tecnologia
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

/** Filtros de classificação: aceitos SÓ pelos endpoints de Tecnologia (os demais dão 400). */
export const TECH_FILTER_RULES: Record<string, (value: string) => boolean> = {
  categoria: (v) => ["TECNOLOGIA", "MOBILIARIO", "VEICULO", "EQUIPAMENTO", "OUTROS", "NAO_CLASSIFICADO"].includes(v),
  tipo_ti: (v) => ["COMPUTADOR", "NOTEBOOK", "MONITOR", "IMPRESSORA", "OUTRO_TI", "NAO_INFORMADO"].includes(v),
  status: (v) => ["EM_USO", "ESTOQUE", "MANUTENCAO", "BAIXADO", "NAO_INFORMADO"].includes(v),
};

const FILTER_ORDER = Object.keys(FILTER_RULES);
const TECH_FILTER_ORDER = [...FILTER_ORDER, ...Object.keys(TECH_FILTER_RULES)];

/** `null` = válido; senão, os nomes inválidos (o backend nunca ecoa valores). */
function invalidParams(
  endpoint: DashboardEndpoint | TechEndpoint,
  query: URLSearchParams,
  extra: Record<string, (value: string) => boolean> = {},
): string[] | null {
  const bad = new Set<string>();
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    const value = values[0] ?? "";
    if (key === "meses" && endpoint === "aquisicoes-mensais") {
      const n = Number(value);
      if (values.length !== 1 || !Number.isInteger(n) || n < 1 || n > 24) bad.add(key);
      continue;
    }
    if (key === "format" && endpoint === "tecnologia/export") {
      if (values.length !== 1 || !["csv", "xlsx"].includes(value)) bad.add(key);
      continue;
    }
    const rule = FILTER_RULES[key] ?? extra[key];
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
const TECH_ROUTE_RE = new RegExp(`^/v1/dashboard/(${TECH_ENDPOINTS.join("|")})$`);

export interface DashboardRequestContext {
  state: {
    dashboard: DashboardMockData;
    dashboardStatus: Partial<Record<DashboardEndpoint | TechEndpoint, number>>;
    /** Dados de Tecnologia (padrão: `defaultTech()`); ausente = padrão. */
    dashboardTech?: TechMockData;
  };
  method: string;
  path: string;
  /** Query string recebida (filtros). */
  query?: URLSearchParams;
  respond: (status: number, payload: unknown) => Promise<void> | void;
  /** Resposta de arquivo (exportação de Tecnologia). */
  respondFile?: (status: number, contentType: string, body: string) => Promise<void> | void;
}

/** Trata `GET /v1/dashboard/<endpoint>`. `true` = tratada. */
export async function handleDashboard(ctx: DashboardRequestContext): Promise<boolean> {
  if (await handleTech(ctx)) return true;
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

/** Trata `GET /v1/dashboard/tecnologia/<nome>`. `true` = tratada. */
async function handleTech(ctx: DashboardRequestContext): Promise<boolean> {
  const match = ctx.path.match(TECH_ROUTE_RE);
  if (!match || ctx.method !== "GET") return false;
  const endpoint = match[1] as TechEndpoint;
  const query = ctx.query ?? new URLSearchParams();
  const invalid = invalidParams(endpoint, query, TECH_FILTER_RULES);
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
  const data = ctx.state.dashboardTech ?? defaultTech();
  if (endpoint === "tecnologia/export") {
    const format = query.get("format") ?? "csv";
    const csv = "Unidade;Categoria;Tipo de TI;Situação operacional;Quantidade\n'-23;Tecnologia;Notebook;Em uso;100\n";
    if (format === "xlsx") {
      await ctx.respondFile?.(200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK-sintetico");
    } else {
      await ctx.respondFile?.(200, "text/csv; charset=utf-8", csv);
    }
    return true;
  }
  const name = endpoint.slice("tecnologia/".length) as keyof TechMockData;
  if (name === "resumo") {
    const applied = TECH_FILTER_ORDER.filter((key) => query.has(key));
    await ctx.respond(200, { ...data.resumo, filtros_aplicados: applied });
    return true;
  }
  await ctx.respond(200, data[name]);
  return true;
}
