// =============================================================================
// Mocks sintéticos de `GET /api/v1/admin/audit-logs[/<id>]` (contrato:
// backend/app/services/admin_audit_service.py). Dados fictícios. O mock imita o
// backend: allowlist de parâmetros (desconhecido/repetido -> 400), janela
// máxima de 90 dias, filtros, ordenação, paginação e 404 uniforme no detalhe.
// =============================================================================

import { mockPage, mockPageSize } from "./page-size";

export interface AuditSummaryMock {
  id: string;
  occurred_at: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  result: "SUCESSO" | "FALHA" | null;
  severity: "low" | "medium" | "high" | "critical" | null;
  request_id: string | null;
}

export interface AuditDetailMock extends AuditSummaryMock {
  target_type: string | null;
  request: { method: string | null; path: string | null; network: string | null } | null;
  details: Record<string, unknown>;
  changes: Record<string, { from?: unknown; to?: unknown }>;
  omitted_fields: number;
}

export const AUDIT_ACTOR_ID = "00000000-0000-4000-8000-0000000000e2";
export const AUDIT_XSS = `<img src=x onerror="window.__xss=1">`;

const ids = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const AUDIT_FIRST_ID = ids(1);
export const AUDIT_SECURITY_ID = ids(2);
export const AUDIT_XSS_ID = ids(3);

/** `count` registros (padrão 30), do mais recente (id 1) ao mais antigo. */
export function defaultAuditLogs(count = 30): AuditDetailMock[] {
  const base = Date.parse("2026-10-20T15:00:00Z");
  const out: AuditDetailMock[] = [];
  for (let n = 1; n <= count; n += 1) {
    const security = n % 5 === 2;
    out.push({
      id: ids(n),
      occurred_at: new Date(base - n * 3_600_000).toISOString(),
      event_type: security ? "PERMISSION_DENIED" : n % 3 === 0 ? "USER_ACTIVATED" : "USER_ROLE_CHANGED",
      entity_type: security ? "security_event" : "user",
      entity_id: security ? null : `20000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`,
      actor_user_id: n === 7 ? null : AUDIT_ACTOR_ID,
      result: n % 4 === 0 ? "FALHA" : "SUCESSO",
      severity: security ? (n === 2 ? "high" : "medium") : null,
      request_id: `req-${n}`,
      target_type: security ? "unit" : null,
      request: security ? { method: "GET", path: "/api/v1/admin/audit-logs", network: "203.0.113.0/24" } : null,
      details: security ? { context: "admin.audit.detail", required: "audit.read" } : {},
      changes: security ? {} : { role: { from: "USER", to: "RH" }, active: { from: false, to: true } },
      omitted_fields: security ? 0 : 2,
    });
  }
  // Valores hostis vindos da API devem ficar inertes (texto puro).
  const hostile = out[2]!;
  hostile.event_type = "USER_ROLE_CHANGED";
  hostile.changes = { role: { from: AUDIT_XSS, to: "RH" } };
  hostile.details = { detail: AUDIT_XSS };
  return out;
}

const ALLOWED = new Set([
  "event_type",
  "entity_type",
  "entity_id",
  "actor_user_id",
  "from",
  "to",
  "result",
  "severity",
  "sort",
  "page",
  "page_size",
]);
const MAX_WINDOW_MS = 90 * 24 * 3_600_000;

type MockReply = { status: number; body: unknown };

const bad = (): MockReply => ({ status: 400, body: { error: { code: "VALIDATION_ERROR", message: "Consulta inválida" } } });
const notFound = (): MockReply => ({ status: 404, body: { error: { code: "not_found", message: "Não encontrado" } } });

function summary(item: AuditDetailMock): AuditSummaryMock {
  const { id, occurred_at, event_type, entity_type, entity_id, actor_user_id, result, severity, request_id } = item;
  return { id, occurred_at, event_type, entity_type, entity_id, actor_user_id, result, severity, request_id };
}

export function auditListReply(logs: AuditDetailMock[], params: URLSearchParams): MockReply {
  for (const key of new Set(params.keys())) {
    if (!ALLOWED.has(key) || params.getAll(key).length !== 1) return bad();
  }
  const now = Date.parse("2026-10-21T12:00:00Z");
  const to = params.get("to") ? Date.parse(params.get("to")!) : now;
  const from = params.get("from") ? Date.parse(params.get("from")!) : to - 30 * 24 * 3_600_000;
  if (Number.isNaN(to) || Number.isNaN(from) || from > to || to - from > MAX_WINDOW_MS) return bad();
  const sort = params.get("sort") ?? "-occurred_at";
  if (sort !== "occurred_at" && sort !== "-occurred_at") return bad();
  const page = mockPage(params);
  const pageSize = mockPageSize(params);
  if (page === null || pageSize === null) return bad();

  let rows = logs.filter((l) => {
    const t = Date.parse(l.occurred_at);
    return t >= from && t <= to;
  });
  const eq = (key: "event_type" | "entity_type" | "entity_id" | "actor_user_id" | "result" | "severity") => {
    const value = params.get(key);
    if (value) rows = rows.filter((l) => l[key] === value);
  };
  (["event_type", "entity_type", "entity_id", "actor_user_id", "result", "severity"] as const).forEach(eq);
  rows = [...rows].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  if (sort === "-occurred_at") rows.reverse();
  return {
    status: 200,
    body: {
      total: rows.length,
      page,
      page_size: pageSize,
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      items: rows.slice((page - 1) * pageSize, page * pageSize).map(summary),
    },
  };
}

export function auditDetailReply(logs: AuditDetailMock[], id: string, params: URLSearchParams): MockReply {
  if ([...params.keys()].length > 0) return bad();
  const found = logs.find((l) => l.id === id);
  return found ? { status: 200, body: found } : notFound();
}
