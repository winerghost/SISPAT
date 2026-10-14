"use client";

import { useState } from "react";
import Image from "next/image";
import { ImageOff } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// =============================================================================
// CarouselImage — imagem com placeholder (skeleton) e tratamento de erro.
// =============================================================================
// SEGURANÇA: as URLs devem vir do backend Flask já AUTORIZADAS (ex.: URL
// assinada de curta duração, emitida após checar perfil/unidade). Nunca use
// URLs públicas/permanentes de bucket nem monte a URL no navegador.
// `unoptimized`: URLs assinadas/privadas não devem passar pelo otimizador do
// Next (ele as buscaria e cachearia no servidor, fora da autorização) e o
// next.config não declara `images.remotePatterns`.
// CSP: `img-src` hoje aceita só 'self' data: blob: — quando o módulo de
// patrimônios existir, a origem das imagens precisará ser incluída em
// src/lib/csp.ts (fora desta fronteira).
// =============================================================================

export interface CarouselImageProps {
  src: string;
  alt: string;
  /** `sizes` responsivo do next/image (padrão: largura total até lg, metade acima). */
  sizes?: string;
  /** Carrega já (primeira imagem visível); as demais são lazy. */
  priority?: boolean;
  /** Ajuste da imagem dentro da moldura. */
  fit?: "cover" | "contain";
  className?: string;
}

export const DEFAULT_IMAGE_SIZES = "(min-width: 1024px) 50vw, 100vw";

export function CarouselImage({
  src,
  alt,
  sizes = DEFAULT_IMAGE_SIZES,
  priority = false,
  fit = "cover",
  className,
}: CarouselImageProps) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-carbon-lift", className)}>
      {status === "loading" && <Skeleton className="absolute inset-0 rounded-none" />}
      {status === "error" ? (
        <ImageFallback text="Imagem indisponível" />
      ) : (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          unoptimized
          priority={priority}
          loading={priority ? undefined : "lazy"}
          placeholder="empty"
          draggable={false}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          className={cn(
            fit === "cover" ? "object-cover" : "object-contain",
            "transition-opacity duration-base ease-factory",
            status === "loaded" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}

/** Moldura neutra para "sem imagem" / "erro ao carregar". */
export function ImageFallback({ text, className }: { text: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={text}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-2 bg-carbon-lift text-pale-stone",
        className,
      )}
    >
      <ImageOff className="size-5" aria-hidden="true" />
      <span aria-hidden="true" className="text-eyebrow">
        {text}
      </span>
    </div>
  );
}
