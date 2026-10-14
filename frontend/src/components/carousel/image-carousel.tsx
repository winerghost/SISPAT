"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

import { Carousel } from "./carousel";
import { CarouselImage, DEFAULT_IMAGE_SIZES, ImageFallback } from "./carousel-image";

// =============================================================================
// ImageCarousel — carrossel de imagens (next/image, lazy, placeholder, erro).
// =============================================================================
// Recebe URLs por props — NENHUMA imagem embutida. As URLs devem ser emitidas
// pelo backend com autorização (ver carousel-image.tsx); nunca públicas.
// Slides podem ter legenda (texto) além da imagem.
// =============================================================================

export interface CarouselImageItem {
  id: string;
  src: string;
  /** Texto alternativo obrigatório (descreva o conteúdo, não "foto"). */
  alt: string;
  caption?: string;
}

export interface ImageCarouselProps {
  label: string;
  images: CarouselImageItem[];
  autoplay?: boolean;
  autoplayInterval?: number;
  sizes?: string;
  /** Classe de proporção da moldura (padrão `aspect-[4/3]`). */
  aspectClassName?: string;
  className?: string;
  /** Texto exibido quando não há imagens. */
  emptyText?: string;
}

export function ImageCarousel({
  label,
  images,
  autoplay = false,
  autoplayInterval,
  sizes = DEFAULT_IMAGE_SIZES,
  aspectClassName = "aspect-[4/3]",
  className,
  emptyText = "Nenhuma imagem disponível",
}: ImageCarouselProps) {
  const slides = useMemo(
    () =>
      images.map((image, index) => ({
        id: image.id,
        label: image.alt,
        content: (
          <figure className="flex flex-col gap-2">
            <div className={cn("overflow-hidden rounded-cards border border-ash-stroke", aspectClassName)}>
              <CarouselImage src={image.src} alt={image.alt} sizes={sizes} priority={index === 0} />
            </div>
            {image.caption && (
              <figcaption className="text-body-sm text-warm-granite">{image.caption}</figcaption>
            )}
          </figure>
        ),
      })),
    [images, sizes, aspectClassName],
  );

  if (images.length === 0) {
    return (
      <div className={cn("overflow-hidden rounded-cards border border-ash-stroke", aspectClassName, className)}>
        <ImageFallback text={emptyText} />
      </div>
    );
  }

  return (
    <Carousel
      label={label}
      slides={slides}
      autoplay={autoplay}
      autoplayInterval={autoplayInterval}
      className={className}
    />
  );
}
