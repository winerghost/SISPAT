// =============================================================================
// Mocks SINTÉTICOS da importação dos cadastros de apoio (unidades, salas,
// pessoas) — contrato docs/architecture/cadastros-apoio-api.md ("Importação dos
// cadastros") e GET /imports/google-sheets/<id>/pending (bens).
// =============================================================================
// Nenhum dado é real: nomes e e-mails (.invalid) são artificiais. O handler
// imita as regras do backend que a UI precisa explicar (ADM + AAL2, allowlists
// de consulta/corpo, 404 uniforme, confirmação idempotente => 409, telefone
// NUNCA na resposta — só `has_phone` —, e-mail mascarado). A autoridade
// continua sendo o backend real. Sem dependência de `mocks.ts` (evita import
// circular): as respostas saem pelo callback `respond`.
// =============================================================================

export type CatalogKind = "units" | "rooms" | "people";
type Classification = "NOVO" | "EXISTENTE" | "DUPLICADO" | "INVALIDO" | "CONFLITANTE";

export interface CatalogImportItemMock {
  id: string;
  row: number;
  source_record_id: string;
  label: string;
  classification: Classification;
  selected: boolean;
  existing: boolean;
  id_conflict: boolean;
  pendencias: string[];
  validation_errors: string[];
  details: Record<string, unknown>;
}

interface PreviewMock {
  kind: CatalogKind;
  confirmed: boolean;
  expiresAt: string;
}

export interface CatalogImportMockOptions {
  /** Status forçado em `POST .../<kind>/preview` (409, 422, 502, 429, 403...). */
  previewStatus?: number;
  /** Status forçado em `GET .../<id>/items`. */
  itemsStatus?: number;
  /** Status forçado em `POST .../<id>/confirm`. */
  confirmStatus?: number;
  /** Confirmação devolve uma falha por item. */
  failures?: boolean;
  /** Confirmação devolve 200 com created=0 e TODOS os itens rejeitados (falha total). */
  allFail?: boolean;
  /** Prévia sem nenhuma pendência (relatório limpo). */
  cleanReport?: boolean;
  /** Atraso (ms) da confirmação — testa botão em `loading`. */
  confirmDelayMs?: number;
  /** Prévia já expirada (`expires_at` no passado). */
  expired?: boolean;
  /** Status forçado em `GET /imports/google-sheets/<id>/pending`. */
  pendingStatus?: number;
  /** Linhas NOVO extras em "people" (testa paginação 50/100/200). */
  extraPeople?: number;
}

export interface CatalogImportMockState extends Required<Omit<CatalogImportMockOptions, "previewStatus" | "itemsStatus" | "confirmStatus" | "pendingStatus">> {
  previewStatus: number | null;
  itemsStatus: number | null;
  confirmStatus: number | null;
  pendingStatus: number | null;
  previews: Record<string, PreviewMock>;
}

export interface CatalogImportHandlerState extends CatalogImportMockState {
  role: string;
  aal: string;
}

export function defaultCatalogImport(opts: CatalogImportMockOptions = {}): CatalogImportMockState {
  return {
    previewStatus: opts.previewStatus ?? null,
    itemsStatus: opts.itemsStatus ?? null,
    confirmStatus: opts.confirmStatus ?? null,
    pendingStatus: opts.pendingStatus ?? null,
    failures: opts.failures ?? false,
    allFail: opts.allFail ?? false,
    cleanReport: opts.cleanReport ?? false,
    confirmDelayMs: opts.confirmDelayMs ?? 0,
    expired: opts.expired ?? false,
    extraPeople: opts.extraPeople ?? 0,
    previews: {},
  };
}

const XSS = `<img src=x onerror="window.__xss=1">`;
const KINDS: CatalogKind[] = ["units", "rooms", "people"];
const KIND_INDEX: Record<CatalogKind, number> = { units: 1, rooms: 2, people: 3 };

export const CATALOG_PREVIEW_IDS: Record<CatalogKind, string> = {
  units: "41000000-0000-4000-8000-000000000001",
  rooms: "41000000-0000-4000-8000-000000000002",
  people: "41000000-0000-4000-8000-000000000003",
};

/** Bens: prévia usada nos mocks existentes (`mocks.ts`). */
export const PENDING_COUNTS_MOCK: Record<string, number> = {
  unidade_sem_alias: 2,
  unidade_inativa: 0,
  unidade_ausente: 0,
  unidade_pertencente_nao_encontrada: 1,
  sala_nao_encontrada: 5,
  sala_ambigua: 0,
  pessoa_nao_encontrada: 3,
  pessoa_ambigua: 1,
  usuario_pessoa_nao_encontrada: 0,
  usuario_pessoa_ambigua: 0,
};

const itemId = (kind: CatalogKind, n: number) =>
  `42${KIND_INDEX[kind]}00000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(
  kind: CatalogKind,
  n: number,
  classification: Classification,
  label: string,
  extra: Partial<CatalogImportItemMock> = {},
): CatalogImportItemMock {
  const eligible = classification === "NOVO" || classification === "EXISTENTE";
  return {
    id: itemId(kind, n),
    row: n + 1,
    source_record_id: String(n),
    label,
    classification,
    selected: eligible,
    existing: classification === "EXISTENTE",
    id_conflict: false,
    pendencias: [],
    validation_errors: [],
    details: {},
    ...extra,
  };
}

function buildItems(kind: CatalogKind, clean: boolean, extraPeople = 0): CatalogImportItemMock[] {
  const base = buildBaseItems(kind, clean);
  if (kind !== "people" || extraPeople <= 0) return base;
  const filler = Array.from({ length: extraPeople }, (_, i) => {
    const n = 100 + i;
    const label = `Pessoa Extra ${String(n).padStart(3, "0")}`;
    return item(kind, n, "NOVO", label, {
      details: { unidade_sigla: "UEA", person_name: label, has_email: false, has_phone: false },
    });
  });
  return [...base, ...filler];
}

function buildBaseItems(kind: CatalogKind, clean: boolean): CatalogImportItemMock[] {
  if (kind === "units") {
    const base = [
      item(kind, 1, "NOVO", "Unidade Estadual Sintética de Teste", {
        details: { unidade_sigla: "UEA", unit_code: "023404", unit_name: "Unidade Estadual Sintética de Teste", create_alias: true },
      }),
      item(kind, 2, "NOVO", "Procuradoria Sintética B", {
        id_conflict: !clean,
        details: { unidade_sigla: "PSB", unit_code: "023405", unit_name: "Procuradoria Sintética B", create_alias: true },
      }),
      item(kind, 3, "EXISTENTE", "Consultoria Sintética C", {
        details: { unidade_sigla: "CSC", unit_code: "023403", unit_name: "Consultoria Sintética C", create_alias: false },
      }),
    ];
    if (clean) return base;
    return [
      ...base,
      item(kind, 4, "INVALIDO", "Linha sem sigla", {
        pendencias: ["sigla_invalida"],
        validation_errors: ["erro: sigla vazia ou com mais de 20 caracteres"],
        details: { unidade_sigla: null, unit_code: null, unit_name: "Linha sem sigla" },
      }),
      item(kind, 5, "DUPLICADO", "Unidade repetida sintética", {
        source_record_id: "2",
        id_conflict: true,
        pendencias: ["sigla_repetida_com_outro_orgao"],
        validation_errors: ["erro: sigla repetida na planilha para outro órgão (linha 3)"],
        details: { unidade_sigla: "PSB", unit_code: "023406", unit_name: "Unidade repetida sintética" },
      }),
    ];
  }
  if (kind === "rooms") {
    const base = [
      item(kind, 1, "NOVO", "Sala 101 Sintética com Nome Bastante Longo para Testar a Quebra de Linha em 320px", {
        details: { unidade_sigla: "UEA", room_name: "Sala 101", probable_duplicate: false },
      }),
      item(kind, 2, "NOVO", `Sala ${XSS}`, {
        details: { unidade_sigla: "UEA", room_name: `Sala ${XSS}`, probable_duplicate: false },
      }),
      item(kind, 3, "EXISTENTE", "Auditório Sintético", {
        details: { unidade_sigla: "PSB", room_name: "Auditório Sintético", probable_duplicate: false },
      }),
    ];
    if (clean) return base;
    return [
      ...base,
      item(kind, 4, "EXISTENTE", "06", {
        details: { unidade_sigla: "UEA", room_name: "06", probable_duplicate: true },
      }),
      item(kind, 5, "CONFLITANTE", "6", {
        details: { unidade_sigla: "UEA", room_name: "6", probable_duplicate: true },
      }),
      item(kind, 6, "INVALIDO", "Sala de sigla desconhecida", {
        pendencias: ["unidade_sem_alias"],
        validation_errors: ["erro: sigla de UNIDADE sem alias cadastrado; linha pendente (nada é chutado)"],
        details: { unidade_sigla: "ZZZ", room_name: "Sala de sigla desconhecida", probable_duplicate: false },
      }),
      item(kind, 7, "DUPLICADO", "Sala repetida sintética", {
        source_record_id: "3",
        id_conflict: true,
        details: { unidade_sigla: "PSB", room_name: "Sala repetida sintética", probable_duplicate: false },
      }),
    ];
  }
  // people: 24 NOVO (paginação) + casos especiais.
  const people: CatalogImportItemMock[] = [];
  for (let n = 1; n <= 24; n += 1) {
    const label = n === 2 ? `Pessoa ${XSS}` : `Pessoa Sintética ${String(n).padStart(2, "0")}`;
    people.push(
      item(kind, n, "NOVO", label, {
        details: {
          unidade_sigla: "UEA",
          person_name: label,
          email_masked: "p***@exemplo.invalid",
          has_email: true,
          has_phone: n % 2 === 0,
          suspect: null,
        },
      }),
    );
  }
  people.push(
    item(kind, 25, "EXISTENTE", "Pessoa Sintética Existente", {
      details: {
        unidade_sigla: "UEA",
        person_name: "Pessoa Sintética Existente",
        email_masked: "e***@exemplo.invalid",
        has_email: true,
        has_phone: true,
        suspect: null,
      },
    }),
  );
  if (clean) return people;
  people.push(
    item(kind, 26, "NOVO", "JÕAO Sintético", {
      details: {
        unidade_sigla: "UEA",
        person_name: "JÕAO Sintético",
        email_masked: "j***@exemplo.invalid",
        has_email: true,
        has_phone: false,
        suspect: ["possível erro de digitação"],
      },
    }),
    item(kind, 27, "DUPLICADO", "Pessoa repetida sintética", {
      source_record_id: "35",
      id_conflict: true,
      details: {
        unidade_sigla: "UEA",
        person_name: "Pessoa repetida sintética",
        email_masked: "p***@exemplo.invalid",
        has_email: true,
        has_phone: true,
      },
    }),
    item(kind, 28, "CONFLITANTE", "Outra pessoa com o mesmo ID", {
      source_record_id: "35",
      id_conflict: true,
      details: { unidade_sigla: "UEA", person_name: "Outra pessoa com o mesmo ID", has_email: false, has_phone: false },
    }),
    item(kind, 29, "INVALIDO", "Ocioso", {
      pendencias: ["marcador_ocioso"],
      validation_errors: ["erro: marcador 'Ocioso' não é pessoa; ignorado"],
      details: { unidade_sigla: "UEA", person_name: "Ocioso", has_email: false, has_phone: false },
    }),
    item(kind, 30, "INVALIDO", "E-mail quebrado", {
      pendencias: ["email_invalido"],
      validation_errors: ["erro: e-mail sem formato/domínio válido; linha não vira pessoa"],
      details: { unidade_sigla: "UEA", person_name: "E-mail quebrado", has_email: false, has_phone: false },
    }),
  );
  return people;
}

function buildReport(kind: CatalogKind, items: CatalogImportItemMock[]) {
  const classes: Record<string, number> = { NOVO: 0, EXISTENTE: 0, DUPLICADO: 0, INVALIDO: 0, CONFLITANTE: 0 };
  const pendencias: Record<string, number> = {};
  const repeated: Record<string, number[]> = {};
  const suspects: { row: number; name: unknown; reasons: unknown }[] = [];
  const probable: { names: unknown[]; rows: number[] }[] = [];
  for (const it of items) {
    classes[it.classification] = (classes[it.classification] ?? 0) + 1;
    for (const code of it.pendencias) pendencias[code] = (pendencias[code] ?? 0) + 1;
    if (it.id_conflict) (repeated[it.source_record_id] ??= []).push(it.row);
    if (it.details.suspect) suspects.push({ row: it.row, name: it.details.person_name, reasons: it.details.suspect });
    if (it.details.probable_duplicate) {
      const last = probable[0];
      if (last) {
        last.names.push(it.details.room_name);
        last.rows.push(it.row);
      } else probable.push({ names: [it.details.room_name], rows: [it.row] });
    }
  }
  return {
    kind,
    total: items.length,
    classificacoes: classes,
    pendencias,
    ids_repetidos: Object.entries(repeated).map(([id, linhas]) => ({ id, linhas })),
    nomes_suspeitos: suspects,
    provaveis_duplicatas: probable.filter((group) => group.rows.length > 1),
  };
}

function summaryOf(items: CatalogImportItemMock[]) {
  const count = (c: Classification) => items.filter((it) => it.classification === c).length;
  return {
    total: items.length,
    novo: count("NOVO"),
    existente: count("EXISTENTE"),
    duplicado: count("DUPLICADO"),
    invalido: count("INVALIDO"),
    conflitante: count("CONFLITANTE"),
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export interface CatalogImportRequestContext {
  state: CatalogImportHandlerState;
  method: string;
  path: string;
  searchParams: URLSearchParams;
  body: unknown;
  respond: (status: number, body?: unknown) => Promise<void>;
}

const ITEMS_PARAMS = new Set(["status", "search", "sort", "page", "page_size"]);
const SORTS = new Set(["label", "classification", "source_id"]);
const STATUSES = new Set(["NOVO", "EXISTENTE", "DUPLICADO", "INVALIDO", "CONFLITANTE"]);
const ROUTE_RE = /^\/v1\/catalog-imports\/([^/]+)\/(preview|items|confirm|report)$/;
const PENDING_RE = /^\/v1\/imports\/google-sheets\/([^/]+)\/pending$/;

/** Trata `/v1/catalog-imports/*` e `/v1/imports/google-sheets/<id>/pending`. `true` = tratada. */
export async function handleCatalogImports(ctx: CatalogImportRequestContext): Promise<boolean> {
  const pending = ctx.path.match(PENDING_RE);
  const match = ctx.path.match(ROUTE_RE);
  if (!match && !pending) return false;
  const { state, method, respond } = ctx;
  const err = async (status: number, code: string, message = "erro sintético") => {
    await respond(status, { error: { code, message } });
    return true;
  };

  // Mesma pilha do backend: ADM + AAL2 (USER/RH => 403; ADM aal1 => AAL2_REQUIRED).
  if (state.role !== "ADM") return err(403, "FORBIDDEN", "Acesso negado.");
  if (state.aal !== "aal2") return err(403, "AAL2_REQUIRED", "MFA obrigatório");

  if (pending) {
    if (method !== "GET") return false;
    if (state.pendingStatus) return err(state.pendingStatus, state.pendingStatus === 404 ? "not_found" : "INTERNAL");
    await respond(200, { preview_id: pending[1], pending_counts: PENDING_COUNTS_MOCK });
    return true;
  }

  const [, segment, action] = match as unknown as [string, string, string];

  if (action === "preview") {
    if (method !== "POST") return false;
    if (!KINDS.includes(segment as CatalogKind)) return err(404, "not_found", "Não encontrado");
    if (state.previewStatus) {
      const code = state.previewStatus === 409 ? "catalog_source_not_configured" : "UPSTREAM";
      return err(state.previewStatus, code);
    }
    if (ctx.body !== undefined) return err(400, "validation_error");
    const kind = segment as CatalogKind;
    const items = buildItems(kind, state.cleanReport, state.extraPeople);
    const id = CATALOG_PREVIEW_IDS[kind];
    const expiresAt = new Date(Date.now() + (state.expired ? -60_000 : 3_600_000)).toISOString();
    state.previews[id] = { kind, confirmed: false, expiresAt };
    await respond(201, {
      preview_id: id,
      kind,
      summary: summaryOf(items),
      expires_at: expiresAt,
      report: buildReport(kind, items),
    });
    return true;
  }

  // Demais rotas: <preview_id> desconhecido => 404 uniforme.
  const preview = state.previews[segment];
  if (!preview) return err(404, "not_found", "Não encontrado");
  const items = buildItems(preview.kind, state.cleanReport, state.extraPeople);

  if (action === "report" && method === "GET") {
    await respond(200, {
      preview_id: segment,
      status: preview.confirmed ? "CONFIRMADA" : "CONCLUIDA",
      expires_at: preview.expiresAt,
      report: buildReport(preview.kind, items),
    });
    return true;
  }

  if (action === "items" && method === "GET") {
    if (state.itemsStatus) return err(state.itemsStatus, state.itemsStatus === 404 ? "not_found" : "INTERNAL");
    for (const key of ctx.searchParams.keys()) if (!ITEMS_PARAMS.has(key)) return err(400, "validation_error");
    const sort = ctx.searchParams.get("sort") ?? "label";
    const field = sort.replace(/^-/, "");
    const status = ctx.searchParams.get("status");
    const search = (ctx.searchParams.get("search") ?? "").toLowerCase();
    const page = Number(ctx.searchParams.get("page") ?? 1);
    const pageSize = Number(ctx.searchParams.get("page_size") ?? 50);
    if (!SORTS.has(field) || search.length > 100 || ![50, 100, 200].includes(pageSize) || page < 1) {
      return err(400, "validation_error");
    }
    if (status && !STATUSES.has(status)) return err(400, "validation_error");
    const dir = sort.startsWith("-") ? -1 : 1;
    const key = field === "label" ? "label" : field === "source_id" ? "source_record_id" : "classification";
    const list = items
      .filter(
        (it) =>
          (!status || it.classification === status) &&
          (!search || it.label.toLowerCase().includes(search) || it.source_record_id.toLowerCase().includes(search)),
      )
      .sort((a, b) => String(a[key]).localeCompare(String(b[key]), "pt-BR", { numeric: true }) * dir);
    await respond(200, {
      preview_id: segment,
      kind: preview.kind,
      total: list.length,
      page,
      page_size: pageSize,
      items: list.slice((page - 1) * pageSize, page * pageSize),
    });
    return true;
  }

  if (action === "confirm" && method === "POST") {
    if (state.confirmDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.confirmDelayMs));
    if (state.confirmStatus) {
      const code = state.confirmStatus === 409 ? "conflict" : state.confirmStatus === 404 ? "not_found" : "INTERNAL";
      return err(state.confirmStatus, code);
    }
    const body = ctx.body as { item_ids?: unknown; alias_item_ids?: unknown } | undefined;
    const keys = typeof body === "object" && body !== null ? Object.keys(body) : ["?"];
    if (
      keys.some((key) => key !== "item_ids" && key !== "alias_item_ids") ||
      !Array.isArray(body?.item_ids) ||
      body.item_ids.length > 10_000
    ) {
      return err(400, "validation_error");
    }
    // `alias_item_ids` (opcional, ≤10.000) deve ser subconjunto de `item_ids`.
    if (body.alias_item_ids !== undefined) {
      const aliases = body.alias_item_ids;
      if (!Array.isArray(aliases) || aliases.length > 10_000) return err(400, "validation_error");
      const allowed = new Set(body.item_ids as string[]);
      if (aliases.some((id) => !allowed.has(id as string))) return err(400, "validation_error");
    }
    if (preview.confirmed || new Date(preview.expiresAt).getTime() <= Date.now()) {
      return err(409, "conflict", "A pré-visualização já foi confirmada, expirou ou não pode ser confirmada.");
    }
    preview.confirmed = true;
    const chosen = new Set(body.item_ids as string[]);
    const eligible = items.filter((it) => chosen.has(it.id) && (it.classification === "NOVO" || it.classification === "EXISTENTE"));
    // `allFail`: HTTP 200 com created=0 e todos os itens rejeitados (falha total).
    const failing = state.allFail
      ? eligible
      : state.failures
        ? eligible.filter((it) => it.classification === "NOVO").slice(0, 1)
        : [];
    const written = eligible.filter((it) => !failing.includes(it));
    const unwrittenItems = items.filter((it) => it.classification !== "NOVO" && it.classification !== "EXISTENTE");
    const porClassificacao: Record<string, number> = { DUPLICADO: 0, INVALIDO: 0, CONFLITANTE: 0 };
    const porMotivo: Record<string, number> = {};
    for (const it of unwrittenItems) {
      porClassificacao[it.classification] = (porClassificacao[it.classification] ?? 0) + 1;
      const codes = it.pendencias.length > 0 ? it.pendencias : [it.classification === "DUPLICADO" ? "duplicado_na_origem" : "outro"];
      for (const code of codes) porMotivo[code] = (porMotivo[code] ?? 0) + 1;
    }
    const created = written.filter((it) => it.classification === "NOVO").length;
    const updated = written.filter((it) => it.classification === "EXISTENTE").length;
    await respond(200, {
      preview_id: segment,
      kind: preview.kind,
      sync_job_id: "51000000-0000-4000-8000-000000000001",
      status: failing.length > 0 ? (created + updated === 0 ? "FALHOU" : "PARCIAL") : "CONCLUIDO",
      created,
      updated,
      ignorados: chosen.size - eligible.length,
      inalterados: 0,
      nao_gravados: {
        total: unwrittenItems.length,
        por_classificacao: porClassificacao,
        por_motivo: porMotivo,
        nao_selecionados: items.filter(
          (it) => (it.classification === "NOVO" || it.classification === "EXISTENTE") && !chosen.has(it.id),
        ).length,
      },
      falhas_total: failing.length,
      falhas: failing.map((it) => ({
        item_id: it.id,
        row: it.row,
        label: it.label,
        reason: "Falha sintética ao gravar este item.",
      })),
    });
    return true;
  }

  return false;
}
