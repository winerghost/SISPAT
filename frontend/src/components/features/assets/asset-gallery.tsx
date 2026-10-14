"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { CarouselImage, ImageFallback } from "@/components/carousel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// =============================================================================
// AssetGallery — galeria de fotos de um patrimônio (miniaturas + ampliação).
// =============================================================================
// AINDA NÃO USADA EM NENHUMA PÁGINA: o módulo de patrimônios não existe. Fica
// pronta para quando o backend expuser as fotos.
//
// SEGURANÇA: recebe URLs por props. Elas DEVEM vir do backend Flask já
// autorizadas para o usuário/unidade (ex.: URL assinada de curta duração) —
// nunca URLs públicas de bucket nem montadas no navegador. Sem imagens
// embutidas. (CSP `img-src` precisará incluir a origem — ver carousel-image.tsx.)
//
// A11y: miniaturas são botões "Ampliar imagem n de N: <alt>"; a ampliação usa
// o Dialog (Radix: foco preso, Esc, retorno de foco à miniatura). No diálogo:
// Anterior/Próximo (também ←/→), zoom por BOTÕES (100–300%, sem gesto
// obrigatório) com estado anunciado em aria-live; a imagem ampliada rola
// dentro da moldura. Sem animação de zoom (troca instantânea, "superfície
// parada"); a entrada do diálogo é a da fundação (fade + scale 0.98, 200ms).
// =============================================================================

export interface GalleryImage {
  id: string;
  /** URL autorizada emitida pelo backend. */
  src: string;
  /** Miniatura opcional (também autorizada); padrão = `src`. */
  thumbnailSrc?: string;
  alt: string;
  caption?: string;
}

export interface AssetGalleryProps {
  images: GalleryImage[];
  /** Nome acessível da lista de miniaturas. */
  label?: string;
  className?: string;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3] as const;

export function AssetGallery({ images, label = "Fotos do patrimônio", className }: AssetGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const count = images.length;

  const current = openIndex !== null ? images[openIndex] : undefined;
  const zoom = ZOOM_LEVELS[zoomStep] ?? 1;

  // Ao trocar de imagem, o zoom volta a 100%.
  useEffect(() => {
    setZoomStep(0);
  }, [openIndex]);

  const go = useCallback(
    (delta: number) => {
      setOpenIndex((index) => (index === null || count === 0 ? index : (index + delta + count) % count));
    },
    [count],
  );

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    if (event.key === "ArrowLeft" && count > 1) {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight" && count > 1) {
      event.preventDefault();
      go(1);
    }
  }

  if (count === 0) {
    return (
      <div className={cn("aspect-[4/3] overflow-hidden rounded-cards border border-ash-stroke", className)}>
        <ImageFallback text="Nenhuma foto cadastrada" />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ul aria-label={label} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {images.map((image, index) => (
          <li key={image.id}>
            <button
              type="button"
              onClick={() => setOpenIndex(index)}
              aria-label={`Ampliar imagem ${index + 1} de ${count}: ${image.alt}`}
              className="block aspect-square w-full overflow-hidden rounded-buttons border border-ash-stroke transition-factory hover:border-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
            >
              <CarouselImage
                src={image.thumbnailSrc ?? image.src}
                alt=""
                sizes="(min-width: 640px) 25vw, 33vw"
              />
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={openIndex !== null} onOpenChange={(open) => !open && setOpenIndex(null)}>
        <DialogContent className="max-w-3xl" onKeyDown={handleDialogKeyDown}>
          {current && openIndex !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Imagem {openIndex + 1} de {count}
                </DialogTitle>
                <DialogDescription>{current.caption ?? current.alt}</DialogDescription>
              </DialogHeader>

              <div
                className="h-[min(60vh,480px)] overflow-auto rounded-cards bg-obsidian-canvas"
                tabIndex={0}
                role="group"
                aria-label={`Imagem ampliada: ${current.alt}`}
              >
                <div
                  className="relative"
                  style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
                >
                  <CarouselImage
                    key={current.id}
                    src={current.src}
                    alt={current.alt}
                    sizes="(min-width: 768px) 768px, 100vw"
                    priority
                    fit="contain"
                    className="bg-obsidian-canvas"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outlineOnLight"
                    size="icon"
                    onClick={() => go(-1)}
                    disabled={count < 2}
                    aria-label="Imagem anterior"
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outlineOnLight"
                    size="icon"
                    onClick={() => go(1)}
                    disabled={count < 2}
                    aria-label="Próxima imagem"
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outlineOnLight"
                    size="icon"
                    onClick={() => setZoomStep((s) => Math.max(s - 1, 0))}
                    disabled={zoomStep === 0}
                    aria-label="Diminuir zoom"
                  >
                    <ZoomOut aria-hidden="true" />
                  </Button>
                  <span
                    aria-live="polite"
                    className="min-w-12 text-center font-mono text-caption tabular-nums text-obsidian-canvas"
                  >
                    <span className="sr-only">Zoom </span>
                    {Math.round(zoom * 100)}%
                  </span>
                  <Button
                    variant="outlineOnLight"
                    size="icon"
                    onClick={() => setZoomStep((s) => Math.min(s + 1, ZOOM_LEVELS.length - 1))}
                    disabled={zoomStep === ZOOM_LEVELS.length - 1}
                    aria-label="Aumentar zoom"
                  >
                    <ZoomIn aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outlineOnLight"
                    size="icon"
                    onClick={() => setZoomStep(0)}
                    disabled={zoomStep === 0}
                    aria-label="Restaurar zoom (100%)"
                  >
                    <RotateCcw aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
