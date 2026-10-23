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

// =============================================================================
// Painel de orientações do login: em InfoSlider + slot opcional de imagem
// institucional (vazio por padrão). >= lg fica ao lado do formulário; abaixo
// de lg fica ABAIXO dele (ordem do DOM).
// =============================================================================
// Autoplay em TODOS os tamanhos (o slide gira também no celular), sempre com
// botão Pausar/Retomar, pausa por hover/foco/interação e desligado sob
// prefers-reduced-motion (tratado dentro do Carousel). Sem JS, o 1º slide fica
// visível (SSR).
// Posicionado DEPOIS do formulário no DOM: o Tab chega primeiro aos campos.
// =============================================================================

export interface AuthGuidancePanelProps {
  /** Imagem institucional AUTORIZADA; padrão: nenhuma. */
  image?: AuthPanelImage | null;
  className?: string;
}

export function AuthGuidancePanel({ image = LOGIN_INSTITUTIONAL_IMAGE, className }: AuthGuidancePanelProps) {
  const headingId = "login-orientacoes-titulo";

  return (
    <div
      aria-labelledby={headingId}
      role="group"
      className={cn("flex min-w-0 flex-col justify-center gap-4", className)}
    >
      {image && (
        <div className="relative aspect-[16/9] overflow-hidden rounded-cards border border-ash-stroke">
          <Image src={image.src} alt={image.alt} fill sizes="(min-width: 1024px) 40vw, 100vw" className="object-cover" />
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
        autoplay
        autoplayInterval={LOGIN_GUIDANCE_INTERVAL}
      />
    </div>
  );
}
