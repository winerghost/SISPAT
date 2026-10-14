"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { filterNavItems, NAV_ITEMS, SETTINGS_HREF } from "@/components/layout/nav-items";
import { useMe } from "@/lib/session";

// =============================================================================
// /configuracoes — índice das subseções de Configurações.
// =============================================================================
// Fonte única: os filhos do grupo "Configurações" em `nav-items.ts`, filtrados
// pelo perfil informado por `GET /api/v1/me` (o mesmo filtro do menu). Ocultar
// um cartão é só UX — cada subseção é autorizada pelo backend (a de IA exige
// ADM + AAL2). Enquanto o perfil não é conhecido, mostra um esboço; em erro,
// nega os itens restritos (filtro com perfil indefinido).
// Cartões "Feature Card Row" do DESIGN.md: borda hairline, sem fill, raio 10px.
// =============================================================================

export default function ConfiguracoesPage() {
  const me = useMe();
  const roles = me.data?.roles;
  const sections = useMemo(
    () => filterNavItems(NAV_ITEMS, roles).find((item) => item.href === SETTINGS_HREF)?.children ?? [],
    [roles],
  );

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Sistema</span>
        <h1 className="text-heading text-bone">Configurações</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Escolha uma seção para ajustar. Você vê apenas as seções disponíveis para o seu perfil.
        </p>
      </div>

      {me.isPending ? (
        <LoadingSkeleton variant="cards" count={2} label="Carregando seções disponíveis…" />
      ) : (
        <StaggerContainer as="ul" className="grid max-w-page gap-6 sm:grid-cols-2" aria-label="Seções de configurações">
          {sections.map((section, index) => {
            const Icon = section.icon;
            return (
              <StaggerItem as="li" key={section.href} index={index} className="flex">
                <Link
                  href={section.href}
                  className="group flex w-full flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding transition-factory hover:border-graphite-mid hover:bg-carbon-lift focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
                >
                  <span className="flex items-center gap-2 text-eyebrow text-pale-stone">
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {section.adminOnly ? "Somente ADM" : "Sua conta"}
                  </span>
                  <span className="text-body text-bone">{section.label}</span>
                  {section.description ? (
                    <span className="text-body-sm text-warm-granite">{section.description}</span>
                  ) : null}
                  <span className="mt-auto inline-flex items-center gap-1 text-body-sm text-bone">
                    Abrir
                    <ArrowRight
                      className="h-4 w-4 transition-transform duration-fast ease-factory group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
                      aria-hidden
                    />
                  </span>
                </Link>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      )}
    </div>
  );
}
