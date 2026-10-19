"use client";

import Link from "next/link";
import { ArrowLeft, Hammer } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModuleDescriptor } from "./module-catalog";

// =============================================================================
// ModuleStatePanel — "Módulo em preparação", honesto.
// Mostra o que o módulo fará, a próxima entrega e um link de volta. NUNCA exibe
// números, tabelas ou listas de dados, e nada é animado além da entrada do
// painel (fade + 4px, 150–200 ms; sem animação sob prefers-reduced-motion).
// Cartão "Feature Card" do DESIGN.md: borda hairline, raio 10px, sem fill.
// =============================================================================

export function ModulePageHeader({ module }: { module: Pick<ModuleDescriptor, "eyebrow" | "title" | "summary"> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-eyebrow text-pale-stone">{module.eyebrow}</span>
      <h1 className="text-heading text-bone">{module.title}</h1>
      <p className="max-w-page text-body-sm text-warm-granite">{module.summary}</p>
    </div>
  );
}

export function ModuleStatePanel({ module }: { module: ModuleDescriptor }) {
  return (
    <SlideIn distance="sm">
      <section
        aria-labelledby={`modulo-${module.key}-estado`}
        data-testid="module-state-panel"
        className="flex max-w-page flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
      >
        <div className="flex flex-col gap-3">
          <Badge className="self-start">
            <Hammer aria-hidden="true" />
            Em preparação
          </Badge>
          <h2 id={`modulo-${module.key}-estado`} className="text-body text-bone">
            Módulo em preparação
          </h2>
          <p className="text-body-sm text-warm-granite">
            Este módulo ainda não está disponível. Por isso nenhum número, lista ou histórico é exibido aqui: só aparecem
            dados confirmados pelo servidor.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-eyebrow text-pale-stone">O que o módulo fará</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-bone marker:text-warm-granite">
            {module.willDo.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-eyebrow text-pale-stone">Próxima entrega</h3>
          <p className="text-body-sm text-bone">{module.nextDelivery}</p>
        </div>

        <Link
          href={module.backHref}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}
        >
          <ArrowLeft aria-hidden="true" />
          {module.backLabel}
        </Link>
      </section>
    </SlideIn>
  );
}
