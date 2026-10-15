"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, ChevronRight, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, useSignedAvatarUrl } from "@/components/features/users/user-avatar";
import { useMe, useSignOut, useSupabaseSession } from "@/lib/session";
import { getMyAvatarUrl } from "@/lib/users-api";
import { MobileNav } from "./mobile-nav";
import { NAV_ITEMS } from "./nav-items";

// =============================================================================
// Header — barra superior persistente (análoga à "Top Navigation Bar" do
// DESIGN.md, adaptada ao shell interno do app): transparente sobre o canvas,
// ~64px de altura, breadcrumbs em Geist 14px e espaço reservado para busca
// global.
// =============================================================================

interface Breadcrumb {
  label: string;
  href: string;
}

function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  // Procura o item (ou subitem) de navegação cujo href corresponde à rota
  // atual, para montar a trilha Home → Grupo → Página com rótulos
  // amigáveis em vez do slug bruto da URL.
  for (const item of NAV_ITEMS) {
    if (item.children) {
      const child = item.children.find(
        (c) => pathname === c.href || pathname.startsWith(`${c.href}/`),
      );
      if (child) {
        return [
          { label: "Home", href: "/" },
          { label: item.label, href: item.href },
          { label: child.label, href: child.href },
        ];
      }
    }
    if (pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`))) {
      return item.href === "/"
        ? [{ label: "Home", href: "/" }]
        : [{ label: "Home", href: "/" }, { label: item.label, href: item.href }];
    }
  }

  // Rota desconhecida (ainda sem entrada em NAV_ITEMS): mostra só "Home".
  return [{ label: "Home", href: "/" }];
}

export function Header() {
  const pathname = usePathname();
  const breadcrumbs = buildBreadcrumbs(pathname);

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-ash-stroke bg-obsidian-canvas px-4 sm:gap-6 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <MobileNav />
        <nav
          aria-label="Trilha de navegação"
          className="flex min-w-0 items-center gap-1 overflow-hidden text-body-sm text-warm-granite"
        >
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <span
                key={crumb.href}
                className={isLast ? "flex min-w-0 items-center gap-1" : "hidden shrink-0 items-center gap-1 sm:flex"}
              >
                {index > 0 && (
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-ash-stroke ${isLast ? "hidden sm:block" : ""}`}
                    aria-hidden
                  />
                )}
                {isLast ? (
                  <span className="truncate text-bone" aria-current="page">
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="inline-flex min-h-6 items-center truncate rounded-nav transition-factory hover:text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
                  >
                    {crumb.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* Busca global — input estático por enquanto, sem lógica de pesquisa.
            Oculta abaixo de md para não espremer a trilha/menu em telas pequenas. */}
        <div className="relative hidden w-56 md:block lg:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-warm-granite" aria-hidden />
          <Input
            type="search"
            placeholder="Buscar patrimônio, unidade, responsável..."
            aria-label="Busca global"
            className="pl-9"
            // Estático por enquanto: sem onChange/onSubmit — a lógica de busca
            // (debounce, chamada à API, resultados) entra em uma rodada futura.
          />
        </div>
        <ProfileLink />
        <SignOutButton />
      </div>
    </header>
  );
}

/**
 * Atalho para "Meu perfil" com o avatar do usuário logado. A foto só é pedida
 * se `/me` informar `has_avatar: true` (UA-FE-01); ausente ou `false` =
 * iniciais (nada é inferido no cliente).
 */
function ProfileLink() {
  const { data: me } = useMe();
  const hasAvatar = me?.has_avatar === true;
  const url = useSignedAvatarUrl(["me", "avatar-url"], getMyAvatarUrl, hasAvatar);
  if (!me) return null;
  return (
    <Link
      href="/configuracoes/perfil"
      aria-label={`Meu perfil (${me.name})`}
      className="inline-flex rounded-buttons transition-factory hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
    >
      <Avatar name={me.name} src={hasAvatar ? url.data?.url : null} size="sm" onImageError={() => void url.refetch()} />
    </Link>
  );
}

/** "Sair" — só aparece com sessão Supabase ativa; encerra a sessão e volta ao login. */
function SignOutButton() {
  const { session } = useSupabaseSession();
  // useSignOut: logout global + limpeza local + redirecionamento para /login.
  const signOut = useSignOut();
  const [pending, setPending] = useState(false);

  if (!session) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      // Microinteração: `loading` = disabled + aria-busy + spinner (rótulo
      // mantido); o ícone desliza 2px no hover (transform, 150ms; desligado
      // sob reduced motion). Lógica de logout inalterada.
      loading={pending}
      aria-label="Sair do sistema"
      className="group"
      onClick={async () => {
        setPending(true);
        try {
          await signOut();
        } finally {
          setPending(false);
        }
      }}
    >
      {!pending && (
        <LogOut
          aria-hidden
          className="transition-transform duration-fast ease-factory group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
        />
      )}
      <span className="hidden sm:inline">Sair</span>
    </Button>
  );
}
