"use client";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { useMe } from "@/lib/session";
import { AccessRestrictedPanel, SESSION_UNCONFIRMED_MESSAGE } from "./access-restricted";
import { MODULES, type ModuleKey } from "./module-catalog";
import { ModulePageHeader, ModuleStatePanel } from "./module-state-panel";

// =============================================================================
// ModulePage — página de um módulo ainda sem backend. Cabeçalho + painel
// honesto. Módulos `adminOnly` negam por padrão: só renderizam o painel quando
// `/me` confirma o papel ADM (UX; o backend continua sendo a autoridade — esta
// página nem consulta dados). A trilha (breadcrumb) vem do Header, a partir de
// `nav-items.ts`, e o destaque no menu da própria rota.
// =============================================================================

export function ModulePage({ module: key }: { module: ModuleKey }) {
  const descriptor = MODULES[key];
  const me = useMe();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);

  let body;
  if (descriptor.adminOnly && me.isPending) {
    body = <LoadingSkeleton variant="lines" count={3} label="Verificando permissões…" />;
  } else if (descriptor.adminOnly && me.isError) {
    body = <AccessRestrictedPanel message={SESSION_UNCONFIRMED_MESSAGE} />;
  } else if (descriptor.adminOnly && !isAdmin) {
    body = <AccessRestrictedPanel />;
  } else {
    body = <ModuleStatePanel module={descriptor} />;
  }

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <ModulePageHeader module={descriptor} />
      {body}
    </div>
  );
}
