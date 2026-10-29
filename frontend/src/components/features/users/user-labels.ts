// =============================================================================
// Rótulos, formatação e mensagens de erro da gestão de usuários.
// =============================================================================
// Nunca exibimos `error.message` vindo da API: cada código do contrato
// (docs/architecture/modulo-configuracoes.md, Etapa 2) vira uma frase humana
// fixa. Datas chegam em UTC e são exibidas em America/Araguaina.
// =============================================================================

import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { UserRole, UserSummary } from "@/lib/users-api";

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Araguaina",
  dateStyle: "short",
  timeStyle: "short",
});

/** Data/hora em America/Araguaina; `null`/inválida → `null`. */
export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_TIME.format(date);
}

/** Até duas iniciais do nome (fallback do avatar). */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ADM: "ADM — Administração",
  USER: "USER — Usuário",
  RH: "RH — Recursos Humanos",
};

export const ROLE_DESCRIPTION: Record<UserRole, string> = {
  ADM: "Gerencia usuários, importações e configurações. Exige verificação em duas etapas.",
  USER: "Consulta e opera o patrimônio das unidades vinculadas.",
  RH: "Acesso restrito à finalidade patrimonial dos responsáveis.",
};

/** Rótulo humano das operações do histórico; desconhecidas aparecem como o código (texto). */
export const OPERATION_LABEL: Record<string, string> = {
  USER_ROLE_CHANGED: "Perfil alterado",
  USER_UNITS_CHANGED: "Unidades alteradas",
  USER_DEACTIVATED: "Conta desativada",
  USER_ACTIVATED: "Conta reativada",
  USER_SESSIONS_REVOKED: "Sessões encerradas",
  USER_PASSWORD_RESET_SENT: "Redefinição de senha enviada",
  USER_PASSWORD_RESET_REQUESTED: "Redefinição de senha solicitada",
  USER_MFA_RESET: "Verificação em duas etapas resetada",
  USER_AVATAR_UPDATED: "Foto atualizada",
  USER_AVATAR_REMOVED: "Foto removida",
  USER_INVITED: "Convite enviado",
  USER_ACCESS_REVOKED: "Acesso revogado",
  REVOKE_ACCESS: "Acesso revogado",
  USER_DELETED: "Usuário excluído (anonimizado)",
  LOGIN: "Entrada no sistema",
};

export const CHANGE_FIELD_LABEL: Record<string, string> = {
  role: "Perfil",
  units: "Unidades",
  active: "Ativo",
  avatar: "Foto",
  sessions_revoked_at: "Sessões encerradas em",
  deleted_at: "Excluído em",
  anonymized_at: "Anonimizado em",
};

// -----------------------------------------------------------------------------
// Exclusão lógica + anonimização
// -----------------------------------------------------------------------------
// Depois da exclusão a linha do usuário continua existindo (o `audit_logs`
// referencia o `actor_user_id`), mas sem dado pessoal: o backend troca o nome
// por um rótulo fixo e o e-mail por um endereço único e não roteável. A tela
// NUNCA mostra esse endereço técnico — mostra o rótulo abaixo. O sinal usado é
// `deleted_at`/`anonymized_at` do próprio payload, nunca o formato da string
// (adivinhar o formato do e-mail anonimizado mascararia usuários legítimos).
// -----------------------------------------------------------------------------

/** Rótulo exibido no lugar do nome de um usuário excluído/anonimizado. */
export const ANONYMIZED_USER_LABEL = "Usuário excluído";

/** `true` quando o backend já marcou a linha como excluída/anonimizada. */
export function isDeletedUser(user: Pick<UserSummary, "deleted_at" | "anonymized_at">): boolean {
  return !!user.deleted_at || !!user.anonymized_at;
}

/** Nome a exibir: o rótulo anonimizado quando o usuário foi excluído. */
export function userDisplayName(user: Pick<UserSummary, "name" | "deleted_at" | "anonymized_at">): string {
  return isDeletedUser(user) ? ANONYMIZED_USER_LABEL : user.name;
}

/**
 * E-mail a exibir, ou `null` para usuário excluído — o endereço anonimizado é
 * ruído técnico e o original não existe mais em lugar nenhum.
 */
export function userDisplayEmail(
  user: Pick<UserSummary, "email" | "deleted_at" | "anonymized_at">,
): string | null {
  return isDeletedUser(user) ? null : user.email;
}

const CODE = {
  versionConflict: "version_conflict",
  lastAdmin: "last_admin",
  selfChange: "self_change_forbidden",
  confirmation: "confirmation_required",
  unitScope: "unit_out_of_scope",
  aal2: "aal2_required",
  reauth: "reauth_required",
  notFound: "not_found",
  tooLarge: "file_too_large",
  unsupported: "unsupported_image",
  storage: "storage_unavailable",
  authProvider: "auth_provider_unavailable",
  // Exclusão de usuário (contrato real de `POST /users/<id>/delete`).
  confirmMismatch: "confirmation_mismatch",
  rateLimitUnavailable: "rate_limit_unavailable",
} as const;

/** Código do backend normalizado (o contrato mistura `AAL2_REQUIRED` e `not_found`). */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code?.toLowerCase() : undefined;
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === CODE.versionConflict;
}

export function isConfirmationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && errorCode(error) === CODE.confirmation;
}

export function isReauthRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && errorCode(error) === CODE.reauth;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** 400 — corpo recusado (campo extra, tipo inválido...). */
export function isBadRequest(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

/** `400 confirmation_mismatch` — o `confirm_text` não é o e-mail do alvo. */
export function isConfirmationMismatch(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && errorCode(error) === CODE.confirmMismatch;
}

/** 409 — autorrevogação, último ADM ou `version` divergente. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export const CONFLICT_MESSAGE =
  "Outra pessoa alterou este usuário enquanto você editava. Os dados foram recarregados — revise e tente de novo.";

export const AAL2_MESSAGE =
  "Esta área exige a verificação em duas etapas (AAL2) concluída nesta sessão. Saia e entre novamente confirmando o código do autenticador.";

export const REAUTH_MESSAGE =
  "Por segurança, confirme o código do seu aplicativo autenticador antes de resetar a verificação em duas etapas de outra pessoa.";

export const REAUTH_MESSAGE_DELETE =
  "Por segurança, confirme o código do seu aplicativo autenticador antes de excluir definitivamente um usuário.";

/** `400 confirmation_mismatch` do `POST /users/<id>/delete`. */
export const DELETE_CONFIRM_MISMATCH =
  "O e-mail digitado não confere com o do usuário. Nada foi excluído. Confira o endereço exato e tente de novo.";

/**
 * Mensagem humana para qualquer erro da gestão de usuários / foto.
 * `fallback` descreve a ação que falhou ("Não foi possível …").
 */
export function userErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const code = errorCode(error);
  if (error.status === 0) return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  if (error.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (code === CODE.aal2) return AAL2_MESSAGE;
  if (code === CODE.reauth) return REAUTH_MESSAGE;
  if (code === CODE.unitScope) {
    return "Uma ou mais unidades escolhidas estão fora do seu escopo de administração. Escolha apenas unidades da lista.";
  }
  if (code === CODE.versionConflict) return CONFLICT_MESSAGE;
  if (code === CODE.lastAdmin) {
    return "Não é possível concluir: esta pessoa é o último administrador (ADM) ativo do sistema. Promova outra pessoa antes.";
  }
  if (code === CODE.selfChange) {
    return "Você não pode alterar o próprio perfil, desativar a própria conta nem resetar o próprio MFA. Peça a outro administrador.";
  }
  if (code === CODE.confirmation) {
    return "Mudanças de privilégio de administrador precisam ser confirmadas. Revise e confirme para continuar.";
  }
  if (code === CODE.tooLarge || error.status === 413) return "A foto deve ter no máximo 2 MB.";
  if (code === CODE.unsupported) {
    return "Imagem não aceita. Envie uma foto JPEG, PNG ou WebP de até 4096 px de lado.";
  }
  if (code === CODE.authProvider || error.status === 502) {
    return "O provedor de autenticação não respondeu. Nada foi alterado; tente novamente em instantes. Se persistir, avise o suporte.";
  }
  if (code === CODE.rateLimitUnavailable) {
    return "O controle de limite de requisições está indisponível. Por segurança a ação foi recusada e nada foi alterado; tente novamente em instantes.";
  }
  if (code === CODE.confirmMismatch) return DELETE_CONFIRM_MISMATCH;
  if (code === CODE.storage || (error.status === 503 && !code)) {
    return "O armazenamento de fotos está indisponível no momento. O restante do sistema continua funcionando.";
  }
  if (code === CODE.notFound || error.status === 404) {
    return "Usuário não encontrado, ou fora do seu escopo de unidades.";
  }
  if (error.status === 403) return "Você não tem permissão para esta ação.";
  if (error.status === 429) return rateLimitMessage(error);
  if (error.status === 400) return "Os dados enviados não foram aceitos. Revise e tente novamente.";
  return fallback;
}
