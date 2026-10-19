"use client";

import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// =============================================================================
// Estado de acesso restrito (negar por padrão). Texto fixo, sem eco do backend.
// Ocultar/negar aqui é só UX: a autorização real é do servidor.
// =============================================================================

export const RESTRICTED_MESSAGE = "Esta área é restrita a administradores (perfil ADM).";
export const SESSION_UNCONFIRMED_MESSAGE = "Não foi possível confirmar sua sessão. Entre novamente.";

export function AccessRestrictedPanel({
  title = "Acesso restrito",
  message = RESTRICTED_MESSAGE,
  backHref = "/",
  backLabel = "Voltar ao início",
}: {
  title?: string;
  message?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <SlideIn distance="sm">
      <section
        aria-labelledby="acesso-restrito-titulo"
        data-testid="access-restricted"
        className="flex max-w-page flex-col gap-4 rounded-cards border border-ash-stroke p-card-padding"
      >
        <Lock className="h-5 w-5 text-warm-granite" aria-hidden="true" />
        <h2 id="acesso-restrito-titulo" className="text-body text-bone">
          {title}
        </h2>
        <p className="text-body-sm text-warm-granite">{message}</p>
        <Link href={backHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}>
          <ArrowLeft aria-hidden="true" />
          {backLabel}
        </Link>
      </section>
    </SlideIn>
  );
}
