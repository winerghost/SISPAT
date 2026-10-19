"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { MatrixPanel } from "@/components/features/admin-access/matrix-panel";
import { RolesPanel } from "@/components/features/admin-access/roles-panel";
import { CatalogHeader, CatalogNotice } from "@/components/features/catalog/catalog-parts";
import { AccessRestrictedPanel, SESSION_UNCONFIRMED_MESSAGE } from "@/components/features/modules/access-restricted";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Tabs } from "@/components/ui/tabs";
import {
  adminAccessErrorMessage,
  ApiError,
  getAdminPermissions,
  getAdminRoles,
  isAccessDenied,
} from "@/lib/admin-access-api";
import { useMe } from "@/lib/session";

// =============================================================================
// /administracao/perfis-permissoes — consulta SOMENTE LEITURA (ADM).
// Dados de `GET /api/v1/admin/roles` e `/admin/permissions` (ADM + AAL2 +
// roles.manage). O frontend só apresenta: perfis e permissões vêm da API e
// 401/403 viram "acesso restrito" com texto fixo (nada do backend é exibido).
// =============================================================================

type TabId = "perfis" | "matriz";
const TABS = [
  { id: "perfis", label: "Perfis" },
  { id: "matriz", label: "Matriz" },
] as const;

const DENIED_ADMIN_MESSAGE =
  "Você não tem permissão para consultar perfis e permissões. É necessário o perfil ADM com a verificação em duas etapas concluída.";

const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1;

export default function PerfisPermissoesPage() {
  const me = useMe();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);
  const [tab, setTab] = useState<TabId>("perfis");

  const rolesQuery = useQuery({ queryKey: ["admin-access", "roles"], queryFn: getAdminRoles, enabled: isAdmin, retry });
  const permsQuery = useQuery({
    queryKey: ["admin-access", "permissions"],
    queryFn: getAdminPermissions,
    enabled: isAdmin && tab === "matriz",
    retry,
  });

  let body: ReactNode;
  if (me.isPending) {
    body = <LoadingSkeleton variant="lines" count={3} label="Verificando permissões…" />;
  } else if (me.isError) {
    body = <AccessRestrictedPanel message={SESSION_UNCONFIRMED_MESSAGE} />;
  } else if (!isAdmin) {
    body = <AccessRestrictedPanel />;
  } else if (isAccessDenied(rolesQuery.error) || isAccessDenied(permsQuery.error)) {
    body = <AccessRestrictedPanel message={DENIED_ADMIN_MESSAGE} />;
  } else {
    const failed = tab === "perfis" ? rolesQuery : rolesQuery.isError ? rolesQuery : permsQuery;
    const ready = tab === "perfis" ? !!rolesQuery.data : !!rolesQuery.data && !!permsQuery.data;
    let content: ReactNode;
    if (failed.isError) {
      content = (
        <CatalogNotice onRetry={() => void failed.refetch()} retrying={failed.isFetching}>
          {adminAccessErrorMessage(failed.error, tab === "perfis" ? "os perfis" : "a matriz de permissões")}
        </CatalogNotice>
      );
    } else if (!ready) {
      content = (
        <LoadingSkeleton
          variant="table"
          count={4}
          columns={3}
          label={tab === "perfis" ? "Carregando perfis…" : "Carregando matriz…"}
        />
      );
    } else if (tab === "perfis") {
      content = <RolesPanel roles={rolesQuery.data!.roles} />;
    } else {
      content = <MatrixPanel roles={rolesQuery.data!.roles} permissions={permsQuery.data!.permissions} />;
    }
    body = (
      <Tabs label="Seções de perfis e permissões" items={TABS} value={tab} onValueChange={setTab}>
        {content}
      </Tabs>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Administração"
        title="Perfis e Permissões"
        description="Consulta dos perfis (ADM, USER e RH), das permissões de cada um e de quantos usuários ativos os utilizam. Somente leitura."
      />
      {body}
    </div>
  );
}
