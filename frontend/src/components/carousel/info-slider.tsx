"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

import { Carousel } from "./carousel";

// =============================================================================
// InfoSlider — carrossel de slides SÓ DE TEXTO (orientações de uso do próprio
// sistema). Não é canal de comunicado oficial: o conteúdo vem por props e
// deve ser texto neutro de ajuda.
// =============================================================================

export interface InfoSlide {
  id: string;
  /** Eyebrow em Geist Mono (ex.: "Segurança"). */
  eyebrow?: string;
  title: string;
  body: string;
}

export interface InfoSliderProps {
  label: string;
  items: InfoSlide[];
  autoplay?: boolean;
  autoplayInterval?: number;
  className?: string;
}

export function InfoSlider({ label, items, autoplay = false, autoplayInterval, className }: InfoSliderProps) {
  const slides = useMemo(
    () =>
      items.map((item) => ({
        id: item.id,
        label: item.title,
        content: (
          <article className="flex h-full min-h-[148px] flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding">
            {item.eyebrow && (
              <span className="flex items-center gap-2 text-eyebrow text-pale-stone">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-signal-orange" />
                {item.eyebrow}
              </span>
            )}
            <h3 className="text-body text-bone">{item.title}</h3>
            <p className="text-body-sm text-warm-granite">{item.body}</p>
          </article>
        ),
      })),
    [items],
  );

  return (
    <Carousel
      label={label}
      slides={slides}
      autoplay={autoplay}
      autoplayInterval={autoplayInterval}
      className={cn(className)}
    />
  );
}
