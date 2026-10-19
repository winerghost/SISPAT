// =============================================================================
// SISPAT-AGU — admin-access-api.ts
// =============================================================================
// Tipos e chamadas SOMENTE LEITURA de `/api/v1/admin/roles` e
// `/api/v1/admin/permissions` (ADM + AAL2 + `roles.manage`; sem query string).
// Só transporte: nenhuma regra de autorização vive aqui — perfis e permissões
// exibidos vêm exclusivamente da API. Caminhos começam em `/v1/...` porque
// `NEXT_PUBLIC_API_URL` já inclui `/api` (ver `users-api.ts`).
// =============================================================================

import { apiClient, ApiError } from "@/lib/api-client";

export interface AccessPermission {
  code: string;
  description: string | null;
  resource: string;
  action: string;
}

export interface AccessRole {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  permissions: AccessPermission[];
  /** Usuários ativos do perfil, contados só nas unidades do ator (ver `users_count_scope`). */
  active_users_count: number;
}

export interface AccessRolesResponse {
  roles: AccessRole[];
  users_count_scope: "actor_units" | string;
}

export interface AccessPermissionRow extends AccessPermission {
  /** Códigos dos perfis que possuem a permissão. */
  roles: string[];
}

export interface AccessPermissionsResponse {
  permissions: AccessPermissionRow[];
}

/** `GET /api/v1/admin/roles`. */
export function getAdminRoles(): Promise<AccessRolesResponse> {
  return apiClient.get<AccessRolesResponse>("/v1/admin/roles");
}

/** `GET /api/v1/admin/permissions`. */
export function getAdminPermissions(): Promise<AccessPermissionsResponse> {
  return apiClient.get<AccessPermissionsResponse>("/v1/admin/permissions");
}

/** Agrupa por `resource` (ordem alfabética), mantendo a ordem de entrada dentro do grupo. */
export function groupByResource<T extends { resource: string }>(items: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.resource);
    if (list) list.push(item);
    else groups.set(item.resource, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "pt-BR"));
}

/** 401/403: a tela vira "acesso restrito" (texto fixo; nada do backend é exibido). */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** Mensagem de falha de carga, sem expor detalhe do backend. */
export function adminAccessErrorMessage(error: unknown, what: string): string {
  if (error instanceof ApiError && error.status === 0) {
    return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
  }
  if (error instanceof ApiError && error.status === 429) {
    return "Muitas consultas em pouco tempo. Aguarde um instante e tente novamente.";
  }
  return `Não foi possível carregar ${what}. Tente novamente.`;
}

export { ApiError };
