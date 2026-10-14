"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";

import { usePrefersReducedMotion } from "@/components/animations";
import { DURATION_MS, EASE_FACTORY_CSS } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

// =============================================================================
// Carousel — base reutilizável sobre Embla (WAI-ARIA APG "Carousel").
// =============================================================================
// Acessibilidade:
//  - Raiz `role="region"` + `aria-roledescription="carousel"` + `aria-label`;
//    focável (tabIndex 0) para receber ←/→ (também Home/End) — as setas
//    funcionam com o foco em qualquer controle do carrossel.
//  - Slides `role="group"` + `aria-roledescription="slide"` + "n de N".
//    Slides fora de vista ficam `inert` (fora do Tab e da árvore acessível).
//  - Anterior/Próximo com rótulo; indicadores são botões "Slide n de N" com
//    `aria-current` no ativo (forma + cor indicam o estado, não só cor).
//  - Autoplay OPCIONAL (WCAG 2.2.2): botão Pausar/Retomar visível; pausa com
//    hover, foco dentro do carrossel e qualquer interação (setas, botões,
//    arraste — a interação deixa o autoplay pausado até "Retomar");
//    DESLIGADO sob prefers-reduced-motion; a região de slides vira
//    `aria-live="polite"` quando não está girando (APG).
//
// Movimento (DESIGN.md > Motion Philosophy — 150–200ms, ease factory, sem
// spring/bounce): o integrador do Embla é físico (velocidade × atrito), não
// temporal — com `duration` curto ele ULTRAPASSA o alvo (bounce: medido ~3%
// em duration 12, ~200ms). Por isso:
//  - navegação por botão/teclado/indicador/autoplay = salto (`jump`) + fade
//    de opacidade de 200ms com cubic-bezier(0.4,0,0.2,1) no slide de destino
//    (Web Animations API; só opacity);
//  - arraste/toque = física do Embla com `duration: 20`, o menor valor sem
//    overshoot perceptível (< 0,1px por 1000px), para o slide acompanhar o dedo;
//  - reduced motion: `duration: 0` (instantâneo) e sem fade.
// =============================================================================

export interface CarouselSlide {
  /** Chave estável do slide. */
  id: string;
  /** Rótulo curto opcional, somado ao "n de N" do slide. */
  label?: string;
  content: ReactNode;
}

export interface CarouselProps {
  /** Nome acessível do carrossel (aria-label da região). */
  label: string;
  slides: CarouselSlide[];
  /** Liga a rotação automática (opcional; padrão desligado). */
  autoplay?: boolean;
  /** Intervalo da rotação automática em ms (mínimo 4000; padrão 7000). */
  autoplayInterval?: number;
  /** Volta ao primeiro slide depois do último (padrão true). */
  loop?: boolean;
  className?: string;
  viewportClassName?: string;
  slideClassName?: string;
  /** Callback ao trocar de slide (índice 0-based). */
  onSelectedChange?: (index: number) => void;
}

const MIN_INTERVAL = 4000;
const DEFAULT_INTERVAL = 7000;
/** Menor `duration` do Embla sem overshoot perceptível (ver cabeçalho). */
const EMBLA_DRAG_DURATION = 20;

const CONTROL =
  "inline-flex h-8 w-8 items-center justify-center rounded-buttons border border-ash-stroke text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

export type AutoplayState = "off" | "playing" | "paused";

export function Carousel({
  label,
  slides,
  autoplay = false,
  autoplayInterval = DEFAULT_INTERVAL,
  loop = true,
  className,
  viewportClassName,
  slideClassName,
  onSelectedChange,
}: CarouselProps) {
  const reduced = usePrefersReducedMotion();
  const count = slides.length;
  const canAutoplay = autoplay && count > 1 && !reduced;
  const delay = Math.max(autoplayInterval, MIN_INTERVAL);

  // Plugins precisam de identidade estável (o hook do Embla reinicia ao mudar).
  const plugins = useMemo(
    () =>
      canAutoplay
        ? [
            Autoplay({
              delay,
              jump: true,
              playOnInit: false,
              // Pausas controladas aqui (estado React), não pelo plugin.
              stopOnInteraction: false,
              stopOnFocusIn: false,
              stopOnMouseEnter: false,
            }),
          ]
        : [],
    [canAutoplay, delay],
  );

  const [viewportRef, emblaApi] = useEmblaCarousel(
    { loop: loop && count > 1, duration: reduced ? 0 : EMBLA_DRAG_DURATION, align: "start" },
    plugins,
  );

  const [selected, setSelected] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const playing = canAutoplay && !userPaused && !hovered && !focusWithin;
  const autoplayState: AutoplayState = !canAutoplay ? "off" : playing ? "playing" : "paused";

  /** Fade de 200ms (só opacity) no slide de destino de uma navegação por salto. */
  const fadeSlide = useCallback((index: number) => {
    if (reducedRef.current) return;
    const el = slideRefs.current[index];
    if (!el || typeof el.animate !== "function") return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: DURATION_MS.base,
      easing: EASE_FACTORY_CSS,
    });
  }, []);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => {
      const index = emblaApi.selectedScrollSnap();
      setSelected(index);
    };
    const onAutoplaySelect = () => fadeSlide(emblaApi.selectedScrollSnap());
    // Arraste/toque também é interação: deixa o autoplay pausado.
    const onPointerDown = () => setUserPaused(true);
    onSelect();
    emblaApi.on("select", onSelect).on("reInit", onSelect).on("pointerDown", onPointerDown);
    emblaApi.on("autoplay:select", onAutoplaySelect);
    return () => {
      emblaApi
        .off("select", onSelect)
        .off("reInit", onSelect)
        .off("pointerDown", onPointerDown)
        .off("autoplay:select", onAutoplaySelect);
    };
  }, [emblaApi, fadeSlide]);

  useEffect(() => {
    onSelectedChange?.(selected);
  }, [selected, onSelectedChange]);

  useEffect(() => {
    const plugin = emblaApi?.plugins().autoplay;
    if (!plugin || !canAutoplay) return;
    if (playing) plugin.play();
    else plugin.stop();
  }, [emblaApi, canAutoplay, playing]);

  const goTo = useCallback(
    (index: number) => {
      if (!emblaApi || count === 0) return;
      const target = loop ? (index + count) % count : Math.min(Math.max(index, 0), count - 1);
      setUserPaused(true);
      if (target === emblaApi.selectedScrollSnap()) return;
      emblaApi.scrollTo(target, true);
      fadeSlide(target);
    },
    [emblaApi, count, loop, fadeSlide],
  );

  const goPrev = useCallback(() => goTo(selected - 1), [goTo, selected]);
  const goNext = useCallback(() => goTo(selected + 1), [goTo, selected]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: goPrev,
      ArrowRight: goNext,
      Home: () => goTo(0),
      End: () => goTo(count - 1),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusWithin(false);
  }

  const baseId = useId();
  const atStart = !loop && selected === 0;
  const atEnd = !loop && selected === count - 1;

  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      data-autoplay={autoplayState}
      data-selected-index={selected}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocusWithin(true)}
      onBlur={handleBlur}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-cards focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas",
        className,
      )}
    >
      <div ref={viewportRef} className={cn("min-w-0 overflow-hidden", viewportClassName)}>
        <div
          id={`${baseId}-slides`}
          className="flex touch-pan-y"
          aria-live={playing ? "off" : "polite"}
        >
          {slides.map((slide, index) => {
            const isSelected = index === selected;
            return (
              <div
                key={slide.id}
                ref={(el) => {
                  slideRefs.current[index] = el;
                }}
                role="group"
                aria-roledescription="slide"
                aria-label={`${slide.label ? `${slide.label} — ` : ""}${index + 1} de ${count}`}
                inert={!isSelected}
                data-active={isSelected ? "true" : "false"}
                className={cn("min-w-0 shrink-0 grow-0 basis-full", slideClassName)}
              >
                {slide.content}
              </div>
            );
          })}
        </div>
      </div>

      {count > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={CONTROL}
              onClick={goPrev}
              disabled={atStart}
              aria-controls={`${baseId}-slides`}
              aria-label="Slide anterior"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <div role="group" aria-label="Escolher slide" className="flex items-center">
              {slides.map((slide, index) => {
                const isSelected = index === selected;
                return (
                  <button
                    key={slide.id}
                    type="button"
                    onClick={() => goTo(index)}
                    aria-controls={`${baseId}-slides`}
                    aria-label={`Slide ${index + 1} de ${count}`}
                    aria-current={isSelected ? "true" : undefined}
                    className="group inline-flex h-6 w-6 items-center justify-center rounded-buttons focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-1.5 rounded-full transition-factory",
                        isSelected ? "w-4 bg-bone" : "w-1.5 bg-warm-granite group-hover:bg-pale-stone",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={CONTROL}
              onClick={goNext}
              disabled={atEnd}
              aria-controls={`${baseId}-slides`}
              aria-label="Próximo slide"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="font-mono text-caption uppercase tabular-nums text-pale-stone">
              {String(selected + 1).padStart(2, "0")}/{String(count).padStart(2, "0")}
            </span>
            {canAutoplay && (
              <button
                type="button"
                className={CONTROL}
                onClick={() => setUserPaused((paused) => !paused)}
                aria-label={
                  userPaused ? "Retomar rotação automática dos slides" : "Pausar rotação automática dos slides"
                }
              >
                {userPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
