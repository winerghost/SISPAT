"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ADMIN_ROLE } from "@/components/layout/nav-items";
import { useMe } from "@/lib/session";
import { AccessRestrictedPanel, SESSION_UNCONFIRMED_MESSAGE } from "./access-restricted";

// =============================================================================
// AdminRedirect — rota "pai" que só encaminha o ADM para a tela real.
// Demais perfis (ou perfil desconhecido) veem o estado de acesso restrito
// (negar por padrão). Redireciona no cliente (nada vai no HTML do servidor).
// Só UX: o backend autoriza cada tela de destino.
// =============================================================================

export function AdminRedirect({
  to,
  title,
  eyebrow,
  restrictedMessage,
}: {
  to: string;
  title: string;
  eyebrow: string;
  restrictedMessage?: string;
}) {
  const me = useMe();
  const router = useRouter();
  const isAdmin = !!me.data?.roles.includes(ADMIN_ROLE);

  useEffect(() => {
    if (isAdmin) router.replace(to);
  }, [isAdmin, router, to]);

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">{eyebrow}</span>
        <h1 className="text-heading text-bone">{title}</h1>
      </div>
      {me.isPending || isAdmin ? (
        <LoadingSkeleton variant="lines" count={2} label={isAdmin ? "Redirecionando…" : "Verificando permissões…"} />
      ) : me.isError ? (
        <AccessRestrictedPanel message={SESSION_UNCONFIRMED_MESSAGE} />
      ) : (
        <AccessRestrictedPanel message={restrictedMessage} />
      )}
    </div>
  );
}
