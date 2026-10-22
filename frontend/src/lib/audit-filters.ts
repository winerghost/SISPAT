// =============================================================================
// SISPAT-AGU — audit-filters.ts
// =============================================================================
// Filtros da trilha de auditoria (`/administracao/auditoria`) na URL, com parse
// DEFENSIVO por allowlist: chave desconhecida, repetida ou valor fora do padrão
// é descartado (a tela nunca quebra e o link nunca carrega valor que o backend
// recusaria). Os padrões espelham `backend/app/api/v1/admin_schemas.py`; a
// validação real é SEMPRE do backend (400). Módulo puro: sem rede, sem React.
// =============================================================================

import { DEFAULT_PAGE_SIZE, parsePageSize, type PageSize } from "@/lib/pagination";

export const AUDIT_MAX_WINDOW_DAYS = 90;

export const AUDIT_RESULTS = ["SUCESSO", "FALHA"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const AUDIT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export type AuditSort = "-occurred_at" | "occurred_at";

export const EVENT_TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const ENTITY_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Filtros aplicados (todos opcionais; `from`/`to` = datas `YYYY-MM-DD` de America/Araguaina). */
export interface AuditFilters {
  event_type?: string;
  entity_type?: string;
  entity_id?: string;
  actor_user_id?: string;
  result?: AuditResult;
  severity?: AuditSeverity;
  from?: string;
  to?: string;
  sort: AuditSort;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = { sort: "-occurred_at" };

/** Estado completo da URL: filtros + página + registro aberto no painel. */
export interface AuditUrlState {
  filters: AuditFilters;
  page: number;
  /** Tamanho da página (backend: 50, 100 ou 200). */
  pageSize: PageSize;
  /** UUID do registro aberto no painel de detalhe. */
  id?: string;
}

/** Ordem canônica das chaves na URL (normalização estável). */
const KEYS = [
  "event_type",
  "entity_type",
  "entity_id",
  "actor_user_id",
  "result",
  "severity",
  "from",
  "to",
  "sort",
  "page",
  "page_size",
  "id",
] as const;

const MAX_PAGE = 100_000;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Valor único e válido, ou `undefined` (chave repetida = descartada). */
function single(params: URLSearchParams, key: string): string | undefined {
  const all = params.getAll(key);
  return all.length === 1 ? all[0] : undefined;
}

export function parseAuditUrl(params: URLSearchParams): AuditUrlState {
  const filters: AuditFilters = { sort: "-occurred_at" };

  const eventType = single(params, "event_type");
  if (eventType && EVENT_TYPE_RE.test(eventType)) filters.event_type = eventType;
  const entityType = single(params, "entity_type");
  if (entityType && ENTITY_TYPE_RE.test(entityType)) filters.entity_type = entityType;
  const entityId = single(params, "entity_id");
  if (entityId && ENTITY_ID_RE.test(entityId)) filters.entity_id = entityId;
  const actor = single(params, "actor_user_id");
  if (actor && UUID_RE.test(actor)) filters.actor_user_id = actor.toLowerCase();
  const result = single(params, "result");
  if (result && (AUDIT_RESULTS as readonly string[]).includes(result)) filters.result = result as AuditResult;
  const severity = single(params, "severity");
  if (severity && (AUDIT_SEVERITIES as readonly string[]).includes(severity)) {
    filters.severity = severity as AuditSeverity;
  }
  const from = single(params, "from");
  if (from && isRealDate(from)) filters.from = from;
  const to = single(params, "to");
  if (to && isRealDate(to)) filters.to = to;
  if (single(params, "sort") === "occurred_at") filters.sort = "occurred_at";

  const rawPage = single(params, "page");
  const parsedPage = rawPage && /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : 1;
  const page = Math.min(MAX_PAGE, Math.max(1, parsedPage));

  const pageSize = parsePageSize(single(params, "page_size"));

  const rawId = single(params, "id");
  const id = rawId && UUID_RE.test(rawId) ? rawId.toLowerCase() : undefined;

  return { filters, page, pageSize, ...(id ? { id } : {}) };
}

/** Query string canônica (sem valores padrão: `sort=-occurred_at`, `page=1`). */
export function auditUrlQuery(state: AuditUrlState): string {
  const { filters, page, pageSize, id } = state;
  const values: Record<(typeof KEYS)[number], string | undefined> = {
    event_type: filters.event_type,
    entity_type: filters.entity_type,
    entity_id: filters.entity_id,
    actor_user_id: filters.actor_user_id,
    result: filters.result,
    severity: filters.severity,
    from: filters.from,
    to: filters.to,
    sort: filters.sort === "occurred_at" ? "occurred_at" : undefined,
    page: page > 1 ? String(page) : undefined,
    page_size: pageSize !== DEFAULT_PAGE_SIZE ? String(parsePageSize(pageSize)) : undefined,
    id,
  };
  const out = new URLSearchParams();
  for (const key of KEYS) {
    const value = values[key];
    if (value) out.set(key, value);
  }
  return out.toString();
}

export function hasAuditFilters(filters: AuditFilters): boolean {
  return !!(
    filters.event_type ||
    filters.entity_type ||
    filters.entity_id ||
    filters.actor_user_id ||
    filters.result ||
    filters.severity ||
    filters.from ||
    filters.to
  );
}

// -----------------------------------------------------------------------------
// Datas: America/Araguaina é UTC-3 fixo (sem horário de verão desde 2019).
// -----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Início do dia (00:00:00.000 em Araguaina) como instante UTC ISO. */
export function dayStartUtc(date: string): string {
  return new Date(`${date}T00:00:00.000-03:00`).toISOString();
}

/** Fim do dia (23:59:59.999 em Araguaina) como instante UTC ISO. */
export function dayEndUtc(date: string): string {
  return new Date(`${date}T23:59:59.999-03:00`).toISOString();
}

/** Mensagem de erro de UX para o período (o backend valida de fato), ou `null`. */
export function periodError(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): string | null {
  if (from && !isRealDate(from)) return "Informe uma data inicial válida.";
  if (to && !isRealDate(to)) return "Informe uma data final válida.";
  if (from && to) {
    if (from > to) return "A data inicial deve ser anterior ou igual à data final.";
    const span = new Date(dayEndUtc(to)).getTime() - new Date(dayStartUtc(from)).getTime();
    if (span > AUDIT_MAX_WINDOW_DAYS * DAY_MS) {
      return `O período máximo é de ${AUDIT_MAX_WINDOW_DAYS} dias.`;
    }
  }
  // Só "de": o backend usa "agora" como fim da janela (futuro ou > 90 dias = 400).
  if (from && !to) {
    const start = new Date(dayStartUtc(from)).getTime();
    if (start > now.getTime()) return "A data inicial não pode estar no futuro.";
    if (now.getTime() - start > AUDIT_MAX_WINDOW_DAYS * DAY_MS) {
      return `O período máximo é de ${AUDIT_MAX_WINDOW_DAYS} dias.`;
    }
  }
  return null;
}

/** Valida os campos de texto do formulário; devolve mensagens por campo. */
export function validateAuditDraft(draft: {
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string;
  from: string;
  to: string;
}): Partial<Record<"event_type" | "entity_type" | "entity_id" | "actor_user_id" | "period", string>> {
  const errors: Partial<Record<"event_type" | "entity_type" | "entity_id" | "actor_user_id" | "period", string>> = {};
  if (draft.event_type && !EVENT_TYPE_RE.test(draft.event_type)) {
    errors.event_type = "Use letras maiúsculas, números e _ (ex.: USER_ROLE_CHANGED).";
  }
  if (draft.entity_type && !ENTITY_TYPE_RE.test(draft.entity_type)) {
    errors.entity_type = "Use letras minúsculas, números e _ (ex.: user).";
  }
  if (draft.entity_id && !ENTITY_ID_RE.test(draft.entity_id)) {
    errors.entity_id = "Até 100 caracteres: letras, números e . _ : -";
  }
  if (draft.actor_user_id && !UUID_RE.test(draft.actor_user_id)) {
    errors.actor_user_id = "Informe um identificador de usuário válido (UUID).";
  }
  const period = periodError(draft.from || undefined, draft.to || undefined);
  if (period) errors.period = period;
  return errors;
}
