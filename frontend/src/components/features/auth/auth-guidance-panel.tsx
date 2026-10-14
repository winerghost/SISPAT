"use client";

import Image from "next/image";

import { InfoSlider } from "@/components/carousel";
import { cn } from "@/lib/utils";

import {
  LOGIN_GUIDANCE,
  LOGIN_GUIDANCE_INTERVAL,
  LOGIN_INSTITUTIONAL_IMAGE,
  type AuthPanelImage,
} from "./login-guidance";
import { LG_QUERY, useMediaQuery } from "./use-media-query";

// =============================================================================
// Painel lateral do login (>= lg): orientações de uso em InfoSlider + slot
// opcional de imagem institucional (vazio por padrão).
// =============================================================================
// Abaixo de lg o painel não aparece (CSS) e o autoplay fica desligado (só
// liga quando a media query lg casa — sem timer rodando em tela oculta).
// Posicionado DEPOIS do formulário no DOM: o Tab chega primeiro aos campos.
// =============================================================================

export interface AuthGuidancePanelProps {
  /** Imagem institucional AUTORIZADA; padrão: nenhuma. */
  image?: AuthPanelImage | null;
  className?: string;
}

export function AuthGuidancePanel({ image = LOGIN_INSTITUTIONAL_IMAGE, className }: AuthGuidancePanelProps) {
  const isDesktop = useMediaQuery(LG_QUERY);
  const headingId = "login-orientacoes-titulo";

  return (
    <div
      aria-labelledby={headingId}
      role="group"
      className={cn("hidden min-w-0 flex-col justify-center gap-4 lg:flex", className)}
    >
      {image && (
        <div className="relative aspect-[16/9] overflow-hidden rounded-cards border border-ash-stroke">
          <Image src={image.src} alt={image.alt} fill sizes="(min-width: 1024px) 40vw, 0px" className="object-cover" />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-eyebrow text-pale-stone">
          Orientações de uso
        </h2>
        <p className="text-caption text-warm-granite">Dicas sobre o funcionamento do sistema.</p>
      </div>
      <InfoSlider
        label="Orientações de uso do sistema"
        items={LOGIN_GUIDANCE}
        autoplay={isDesktop}
        autoplayInterval={LOGIN_GUIDANCE_INTERVAL}
      />
    </div>
  );
}
