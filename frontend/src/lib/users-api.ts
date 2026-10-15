// =============================================================================
// SISPAT-AGU — users-api.ts
// =============================================================================
// Tipos e chamadas da gestão de usuários (contrato em
// docs/architecture/modulo-configuracoes.md, "Etapa 2 — Gestão de usuários"),
// do convite/ativação e da foto de perfil do próprio usuário. Só transporte:
// perfil, unidade, escopo, AAL2, reautenticação, "último ADM", tamanho/tipo
// de imagem — tudo é decidido pelo backend Flask.
//
// Autenticação: o `apiClient` anexa `Authorization: Bearer <token>` da sessão
// Supabase atual a toda chamada (ver `api-client.ts`) — por isso não há mais
// `getAuthHeaders()` manual aqui.
//
// Caminhos começam em `/v1/...` porque `NEXT_PUBLIC_API_URL` já inclui `/api`.
// IDs vindos da UI são sempre `encodeURIComponent` (o backend devolve o mesmo
// 404 para ID inexistente, alheio ou malformado).
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";

// -----------------------------------------------------------------------------
// Tipos do contrato
// -----------------------------------------------------------------------------

export type UserRole = "ADM" | "USER" | "RH";
export const USER_ROLES: readonly UserRole[] = ["ADM", "USER", "RH"];

export interface UnitRef {
  id: string;
  code: string;
  name: string;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  active: boolean;
  /** `null` = sem perfil (acesso revogado). */
  role: UserRole | null;
  units: UnitRef[];
  has_avatar: boolean;
  /** ISO 8601 UTC. */
  created_at: string;
  last_login_at: string | null;
  deactivated_at: string | null;
  version: number;
}

/** Ordenações aceitas pela allowlist do backend. */
export type UserSort =
  | "name"
  | "-name"
  | "email"
  | "-email"
  | "created_at"
  | "-created_at"
  | "last_login_at"
  | "-last_login_at";

export interface ListUsersParams {
  /** Nome ou e-mail (trecho), até 100 caracteres. */
  q?: string;
  role?: UserRole;
  unit_id?: string;
  active?: boolean;
  sort?: UserSort;
  page?: number;
  /** 1 a 100 (padrão do backend: 25). */
  page_size?: number;
}

export interface UsersListResponse {
  total: number;
  page: number;
  page_size: number;
  users: UserSummary[];
}

export interface UnitsResponse {
  units: UnitRef[];
}

/** Corpo do PATCH (`extra="forbid"`): só estes campos; `version` obrigatório. */
export interface UpdateUserRequest {
  version: number;
  role?: UserRole;
  /** 1 a 50 unidades do escopo do ADM. */
  unit_ids?: string[];
  /** Obrigatório ao promover a ADM ou rebaixar um ADM. */
  confirm_privilege_change?: true;
}

export interface DeactivateUserRequest {
  version: number;
  /** Motivo opcional, até 1000 caracteres. */
  reason?: string;
}

export interface RevokeSessionsResponse {
  sessions_revoked_at: string;
}

export interface PasswordResetResponse {
  result: "sent" | "unavailable";
}

export interface MfaResetResponse {
  removed_factors: number;
}

export interface AuditActor {
  id: string;
  name: string;
}

/** Valores de `changes` vêm da allowlist do backend (role, units, active, avatar, sessions_revoked_at). */
export interface AuditChange {
  from?: unknown;
  to?: unknown;
}

export interface UserAuditEvent {
  id: string;
  occurred_at: string;
  operation: string;
  result: string;
  actor: AuditActor | null;
  changes: Record<string, AuditChange | unknown> | null;
}

export interface UserAuditResponse {
  total: number;
  page: number;
  page_size: number;
  events: UserAuditEvent[];
}

export interface AvatarUrlResponse {
  /** URL assinada (temporária) do bucket privado. */
  url: string;
  /** Validade em segundos (ex.: 300). */
  expires_in: number;
}

export interface AvatarUploadResponse {
  has_avatar: boolean;
}

/** Limites aceitos pelo backend — no cliente servem só para orientar (UX). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// -----------------------------------------------------------------------------
// Convite / ativação
// -----------------------------------------------------------------------------

export type IntendedRoleCode = "USER" | "RH";

export interface InviteUserRequest {
  email: string;
  name: string;
  intended_role_code: IntendedRoleCode;
  unit_ids: string[];
  justification?: string;
}

export interface InviteUserResponse {
  id: string;
  email: string;
  name: string;
  intended_role_code: IntendedRoleCode;
  status: string;
  unit_ids: string[];
  created_at?: string;
}

export interface ActivateInviteResponse {
  role: string;
  units: unknown[];
}

/** `POST /api/v1/users/invite` — ADM + AAL2 + `users.invite`. */
export function inviteUser(payload: InviteUserRequest): Promise<InviteUserResponse> {
  return apiClient.post<InviteUserResponse>("/v1/users/invite", payload);
}

/**
 * `POST /api/v1/users/activate-invite` — sem corpo; o backend identifica o
 * convite pela sessão Supabase atual (criada em `/ativar-conta`).
 */
export function activateInvite(): Promise<ActivateInviteResponse> {
  return apiClient.post<ActivateInviteResponse>("/v1/users/activate-invite");
}

// -----------------------------------------------------------------------------
// Gestão de usuários (ADM + AAL2 + permissão específica, escopo de unidade)
// -----------------------------------------------------------------------------

const userPath = (id: string, suffix = "") => `/v1/users/${encodeURIComponent(id)}${suffix}`;

/** `GET /api/v1/users` — lista paginada com busca, filtros e ordenação (allowlist). */
export function listUsers(params: ListUsersParams = {}): Promise<UsersListResponse> {
  return apiClient.get<UsersListResponse>("/v1/users", {
    searchParams: {
      q: params.q?.trim() || undefined,
      role: params.role,
      unit_id: params.unit_id,
      active: params.active,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

/** `GET /api/v1/users/<id>` — 404 `not_found` também para alvo fora do escopo. */
export function getUser(id: string): Promise<UserSummary> {
  return apiClient.get<UserSummary>(userPath(id));
}

/** `GET /api/v1/units` — unidades do escopo do ADM (seletor de vínculos). */
export function listUnits(): Promise<UnitsResponse> {
  return apiClient.get<UnitsResponse>("/v1/units");
}

/** `PATCH /api/v1/users/<id>` — perfil e/ou unidades. */
export function updateUser(id: string, payload: UpdateUserRequest): Promise<UserSummary> {
  return apiClient.patch<UserSummary>(userPath(id), payload);
}

/** `POST /users/<id>/deactivate` — desativa, bloqueia e encerra as sessões. */
export function deactivateUser(id: string, payload: DeactivateUserRequest): Promise<UserSummary> {
  return apiClient.post<UserSummary>(userPath(id, "/deactivate"), payload);
}

/** `POST /users/<id>/activate` — reativa a conta. */
export function activateUser(id: string, version: number): Promise<UserSummary> {
  return apiClient.post<UserSummary>(userPath(id, "/activate"), { version });
}

/** `POST /users/<id>/revoke-sessions` — encerra todas as sessões abertas. */
export function revokeUserSessions(id: string): Promise<RevokeSessionsResponse> {
  return apiClient.post<RevokeSessionsResponse>(userPath(id, "/revoke-sessions"));
}

/** `POST /users/<id>/password-reset` — e-mail de redefinição (o ADM nunca vê link/senha). */
export function sendPasswordReset(id: string): Promise<PasswordResetResponse> {
  return apiClient.post<PasswordResetResponse>(userPath(id, "/password-reset"));
}

/** `POST /users/<id>/mfa-reset` — exige reautenticação TOTP recente (403 `REAUTH_REQUIRED`). */
export function resetUserMfa(id: string): Promise<MfaResetResponse> {
  return apiClient.post<MfaResetResponse>(userPath(id, "/mfa-reset"));
}

/** `GET /users/<id>/audit` — histórico paginado (alvo ou autor). */
export function getUserAudit(
  id: string,
  params: { page?: number; page_size?: number } = {},
): Promise<UserAuditResponse> {
  return apiClient.get<UserAuditResponse>(userPath(id, "/audit"), {
    searchParams: { page: params.page, page_size: params.page_size },
  });
}

function avatarForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

/** `GET /users/<id>/avatar-url` — URL assinada temporária; 404 quando não há foto. */
export function getUserAvatarUrl(id: string): Promise<AvatarUrlResponse> {
  return apiClient.get<AvatarUrlResponse>(userPath(id, "/avatar-url"));
}

/** `PUT /users/<id>/avatar` — multipart (`file`). */
export function uploadUserAvatar(id: string, file: File): Promise<AvatarUploadResponse> {
  return apiClient.put<AvatarUploadResponse>(userPath(id, "/avatar"), avatarForm(file));
}

/** `DELETE /users/<id>/avatar`. */
export function deleteUserAvatar(id: string): Promise<unknown> {
  return apiClient.delete<unknown>(userPath(id, "/avatar"));
}

// -----------------------------------------------------------------------------
// Foto do próprio usuário (qualquer perfil autenticado)
// -----------------------------------------------------------------------------

/** `GET /api/v1/me/avatar-url` — 404 quando não há foto. */
export function getMyAvatarUrl(): Promise<AvatarUrlResponse> {
  return apiClient.get<AvatarUrlResponse>("/v1/me/avatar-url");
}

/** `PUT /api/v1/me/avatar` — multipart (`file`). */
export function uploadMyAvatar(file: File): Promise<AvatarUploadResponse> {
  return apiClient.put<AvatarUploadResponse>("/v1/me/avatar", avatarForm(file));
}

/** `DELETE /api/v1/me/avatar`. */
export function deleteMyAvatar(): Promise<unknown> {
  return apiClient.delete<unknown>("/v1/me/avatar");
}

// -----------------------------------------------------------------------------
// MFA do próprio usuário
// -----------------------------------------------------------------------------

/**
 * `DELETE /api/v1/security/mfa/factors/{factor_id}` — remove um fator MFA
 * do PRÓPRIO usuário (usado por `/configuracoes/seguranca`). NUNCA chamar
 * `supabase.auth.mfa.unenroll()` no lugar desta função.
 */
export async function removeMfaFactor(factorId: string): Promise<void> {
  await apiClient.delete<unknown>(`/v1/security/mfa/factors/${encodeURIComponent(factorId)}`);
}

/**
 * `POST /api/v1/security/mfa/factor-added-notice` (sem corpo) — avisa o backend
 * que o usuário cadastrou um fator TOTP (o backend audita/notifica). BEST-EFFORT:
 * qualquer falha é ignorada e nunca bloqueia o fluxo de MFA.
 */
export async function notifyMfaFactorAdded(): Promise<void> {
  try {
    await apiClient.post<unknown>("/v1/security/mfa/factor-added-notice");
  } catch {
    /* aviso é complementar; o cadastro do fator já foi concluído */
  }
}

export { ApiError };
