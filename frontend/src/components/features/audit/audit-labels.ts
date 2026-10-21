// =============================================================================
// Rótulos e mensagens da trilha de auditoria. Nunca exibimos `error.message`
// vindo da API; textos de erro são fixos. Datas em America/Araguaina.
// =============================================================================

import { OPERATION_LABEL, formatDateTime } from "@/components/features/users/user-labels";
import { rateLimitMessage } from "@/lib/api-errors";
import { ApiError } from "@/lib/api-client";
import type { AuditValue } from "@/lib/audit-api";

export { formatDateTime };

const FULL_DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Araguaina",
  dateStyle: "short",
  timeStyle: "medium",
});

/** Data/hora com segundos em America/Araguaina (detalhe). */
export function formatDateTimeFull(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : FULL_DATE_TIME.format(date);
}

export const SEVERITY_LABEL: Record<string, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  critical: "Crítica",
};

export const RESULT_LABEL: Record<string, string> = {
  SUCESSO: "Sucesso",
  FALHA: "Falha",
};

/** Rótulo humano quando o código é conhecido; senão o próprio código (texto). */
export function eventLabel(code: string): string {
  return OPERATION_LABEL[code] ?? code;
}

export const FIELD_LABEL: Record<string, string> = {
  role: "Perfil",
  roles: "Perfis",
  units: "Unidades",
  active: "Ativo",
  avatar: "Foto",
  deleted: "Excluído",
  status: "Situação",
  version: "Versão",
  density: "Densidade",
  font_scale: "Escala da fonte",
  kind: "Tipo",
  created: "Criados",
  updated: "Atualizados",
  skipped: "Ignorados",
  failed: "Falhas",
  total: "Total",
  provider: "Provedor",
  model: "Modelo",
  feature: "Recurso",
  outcome: "Resultado",
  tokens_in: "Tokens de entrada",
  tokens_out: "Tokens de saída",
  enabled: "Habilitado",
  deepseek_acknowledged: "Aceite DeepSeek",
  sessions_revoked_at: "Sessões encerradas em",
  invite_superseded: "Convite substituído",
  removed_factors: "Fatores removidos",
  unit_id: "Unidade",
  from_unit_id: "Unidade de origem",
  to_unit_id: "Unidade de destino",
  room_id: "Sala",
  location_id: "Local",
  has_notes: "Possui observações",
  context: "Contexto",
  reason: "Motivo",
  required: "Exigido",
  operation: "Operação",
  fields: "Campos",
  unit_ids: "Unidades",
  from: "De",
  to: "Para",
  detail: "Detalhe",
};

export function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key;
}

/** Texto de um valor já projetado pelo backend. Sempre string (o React escapa). */
export function formatAuditValue(value: AuditValue | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) {
    if (value.length === 0) return "nenhum";
    return value.map((item) => formatAuditValue(item)).join(", ");
  }
  return String(value);
}

export const AUDIT_DENIED_MESSAGE =
  "Você não tem permissão para consultar a auditoria. É necessário o perfil ADM com a verificação em duas etapas concluída.";

export function auditListErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 400) {
      return "Os filtros não foram aceitos (verifique o período de até 90 dias). Ajuste ou limpe os filtros e tente novamente.";
    }
  }
  return "Não foi possível carregar a trilha de auditoria. Tente novamente.";
}

export function auditDetailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
    if (error.status === 404) return "Registro não encontrado, ou fora do seu escopo de unidades.";
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 401 || error.status === 403) return AUDIT_DENIED_MESSAGE;
  }
  return "Não foi possível carregar este registro. Tente novamente.";
}

/** Identificador longo abreviado para a tabela (o completo fica no detalhe). */
export function shortId(value: string | null): string {
  if (!value) return "—";
  return value.length > 13 ? `${value.slice(0, 8)}…` : value;
}
