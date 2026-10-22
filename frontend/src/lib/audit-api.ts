// =============================================================================
// SISPAT-AGU — audit-api.ts
// =============================================================================
// Tipos e chamadas SOMENTE LEITURA de `GET /api/v1/admin/audit-logs` e
// `/admin/audit-logs/<id>` (ADM + AAL2 + `audit.read`; contrato em
// backend/app/services/admin_audit_service.py). Só transporte: escopo de
// unidade, projeção sem segredos (allowlist, IP só como rede /24 ou /48) e
// autorização são do backend. Caminhos começam em `/v1/...` (a base já inclui
// `/api`). O ID vindo da UI passa por `encodeURIComponent`.
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";
import { dayEndUtc, dayStartUtc, type AuditFilters } from "@/lib/audit-filters";

/** Valor escalar já projetado pelo backend (texto curto, número, booleano ou null). */
export type AuditScalar = string | number | boolean | null;
export type AuditValue = AuditScalar | AuditScalar[];

export interface AuditLogSummary {
  id: string;
  /** ISO 8601 UTC. */
  occurred_at: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  result: "SUCESSO" | "FALHA" | null;
  severity: "low" | "medium" | "high" | "critical" | null;
  request_id: string | null;
}

export interface AuditLogsResponse {
  total: number;
  page: number;
  page_size: number;
  window: { from: string; to: string };
  items: AuditLogSummary[];
}

export interface AuditChangeValue {
  from?: AuditValue;
  to?: AuditValue;
}

export interface AuditLogDetail extends AuditLogSummary {
  target_type: string | null;
  /** Só em eventos de segurança. `network` = rede do IP (nunca o endereço). */
  request: { method: string | null; path: string | null; network: string | null } | null;
  details: Record<string, AuditValue>;
  changes: Record<string, AuditChangeValue>;
  /** Campos fora da allowlist do backend (só a contagem). */
  omitted_fields: number;
}

/** `GET /api/v1/admin/audit-logs` — filtros por allowlist, página e ordenação. */
export function listAuditLogs(filters: AuditFilters, page: number, pageSize: number): Promise<AuditLogsResponse> {
  return apiClient.get<AuditLogsResponse>("/v1/admin/audit-logs", {
    searchParams: {
      event_type: filters.event_type,
      entity_type: filters.entity_type,
      entity_id: filters.entity_id,
      actor_user_id: filters.actor_user_id,
      result: filters.result,
      severity: filters.severity,
      from: filters.from ? dayStartUtc(filters.from) : undefined,
      to: filters.to ? dayEndUtc(filters.to) : undefined,
      sort: filters.sort,
      page,
      page_size: pageSize,
    },
  });
}

/** `GET /api/v1/admin/audit-logs/<id>` — 404 também para registro alheio/inexistente. */
export function getAuditLog(id: string): Promise<AuditLogDetail> {
  return apiClient.get<AuditLogDetail>(`/v1/admin/audit-logs/${encodeURIComponent(id)}`);
}

/** 401/403: a tela vira "acesso restrito" (texto fixo; nada do backend é exibido). */
export function isAuditDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export { ApiError };
