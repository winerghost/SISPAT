// =============================================================================
// SISPAT-AGU — users-api.ts
// =============================================================================
// Funções tipadas para o fluxo de convite/ativação/revogação/listagem de
// usuários e para a remoção de fator MFA, todas sobre o `apiClient` já
// existente (ver `@/lib/api-client`). Nenhuma lógica de rede é
// reimplementada aqui — apenas o contrato de tipos e os caminhos do
// backend.
//
// Autenticação: todos os endpoints abaixo exigem a sessão Supabase do
// usuário logado (`Authorization: Bearer <access_token>`). `apiClient`
// ainda não anexa esse header automaticamente (ver TODO em
// `api-client.ts`) — por isso cada função aqui busca o token da sessão
// atual via `getAuthHeaders()` (`@/lib/session`) antes de chamar o
// backend, sem precisar alterar `api-client.ts`.
//
// Observação sobre caminhos: `NEXT_PUBLIC_API_URL` já inclui o prefixo
// `/api` (ver `.env.example`), e as rotas do backend vivem sob
// `/api/v1/...`. Por isso os caminhos abaixo começam em `/v1/...` (sem
// repetir `/api`) — ver `buildUrl` em `api-client.ts`.
//
// Contratos de resposta: conferidos e alinhados com a implementação real de
// `backend/app/api/v1/users.py` (`_serialize_invite`/`_serialize_user`) —
// `GET /users` retorna a lista paginada na chave `users` (não `items`, que é
// a convenção usada só em `imports-api.ts`), e cada usuário expõe `active`
// (booleano), não `status` (string).
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";
import { getAuthHeaders } from "@/lib/session";

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

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  active: boolean;
  roles: string[];
}

export interface UsersListResponse {
  total: number;
  page: number;
  page_size: number;
  users: UserListItem[];
}

export interface ListUsersParams {
  page?: number;
  page_size?: number;
  /**
   * Ainda NÃO suportado por `GET /api/v1/users` (o backend real só aceita
   * `page`/`page_size`) — mantido aqui apenas como ponto de extensão para
   * quando o endpoint ganhar essa capacidade. Hoje é ignorado pelo backend
   * se enviado.
   */
  search?: string;
}

/** `POST /api/v1/users/invite` — convida um novo usuário (ADM + AAL2 + `users.invite`). */
export async function inviteUser(payload: InviteUserRequest): Promise<InviteUserResponse> {
  const headers = await getAuthHeaders();
  return apiClient.post<InviteUserResponse>("/v1/users/invite", payload, { headers });
}

/**
 * `POST /api/v1/users/activate-invite` — sem corpo; o backend identifica o
 * convite a partir da sessão Supabase atual (token enviado em
 * `Authorization`), criada após o usuário definir a senha em
 * `/ativar-conta` (ver `supabase.auth.updateUser`).
 */
export async function activateInvite(): Promise<ActivateInviteResponse> {
  const headers = await getAuthHeaders();
  return apiClient.post<ActivateInviteResponse>("/v1/users/activate-invite", undefined, {
    headers,
  });
}

/** `POST /api/v1/users/{id}/revoke` — revoga o acesso de um usuário. */
export async function revokeUser(id: string): Promise<void> {
  const headers = await getAuthHeaders();
  await apiClient.post<unknown>(`/v1/users/${encodeURIComponent(id)}/revoke`, undefined, {
    headers,
  });
}

/** `GET /api/v1/users` — lista paginada de usuários (ADM + `users.manage`). */
export async function listUsers(params: ListUsersParams = {}): Promise<UsersListResponse> {
  const headers = await getAuthHeaders();
  return apiClient.get<UsersListResponse>("/v1/users", {
    headers,
    searchParams: {
      page: params.page,
      page_size: params.page_size,
      search: params.search || undefined,
    },
  });
}

/**
 * `DELETE /api/v1/security/mfa/factors/{factor_id}` — remove um fator MFA
 * do PRÓPRIO usuário. Usado por `/configuracoes/seguranca`. NUNCA chamar
 * `supabase.auth.mfa.unenroll()` diretamente no lugar desta função — ver
 * comentário em `supabase-client.ts`.
 */
export async function removeMfaFactor(factorId: string): Promise<void> {
  const headers = await getAuthHeaders();
  await apiClient.delete<unknown>(`/v1/security/mfa/factors/${encodeURIComponent(factorId)}`, {
    headers,
  });
}

export { ApiError };
