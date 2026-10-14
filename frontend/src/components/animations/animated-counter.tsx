"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { animate } from "motion/react";

import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { DURATION, EASE_FACTORY } from "@/lib/motion/tokens";

import { useEntranceInitial } from "./use-entrance";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface AnimatedCounterProps {
  /** Valor REAL vindo do backend/props. Nunca passe números de demonstração. */
  value: number;
  /** Formatação (padrão pt-BR, inteiro). */
  format?: (n: number) => string;
  /** Casas decimais usadas pelo formatador padrão. */
  decimals?: number;
  /** Duração em segundos (padrão DURATION.slow; teto 0.6s). */
  duration?: number;
  /**
   * Anúncio para leitores de tela quando o valor MUDA ("polite" padrão,
   * "off" em grades com muitos números). Só o valor final é anunciado.
   */
  live?: "polite" | "off";
  className?: string;
}

/**
 * Contador 0 → valor real. Garantias:
 * - SSR/HTML e leitor de tela sempre recebem o valor FINAL exato;
 * - a contagem visual é escrita direto no DOM (sem re-render por frame) e
 *   termina exatamente em `value`;
 * - sob prefers-reduced-motion não anima (mostra o valor final);
 * - `tabular-nums` evita "tremor" de largura durante a contagem.
 */
export function AnimatedCounter({
  value,
  format,
  decimals = 0,
  duration = DURATION.slow,
  live = "polite",
  className,
}: AnimatedCounterProps) {
  const reduced = usePrefersReducedMotion();
  const visualRef = useRef<HTMLSpanElement>(null);
  // Montado durante a hidratação (valor já veio no HTML) ou sob reduced
  // motion: começa no próprio valor — sem "voltar a zero" visível.
  const entrance = useEntranceInitial();
  const fromRef = useRef(entrance === false ? value : 0);

  const fmt = useMemo(() => {
    if (format) return format;
    const nf = new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return (n: number) => nf.format(n);
  }, [format, decimals]);

  const finalText = Number.isFinite(value) ? fmt(value) : "—";

  useIsoLayoutEffect(() => {
    const el = visualRef.current;
    if (!el || !Number.isFinite(value)) return;
    const from = fromRef.current;
    fromRef.current = value;
    if (reduced || from === value) {
      el.textContent = fmt(value);
      return;
    }
    el.textContent = fmt(from);
    const controls = animate(from, value, {
      type: "tween",
      duration: Math.min(duration, 0.6),
      ease: EASE_FACTORY,
      onUpdate: (latest) => {
        el.textContent = fmt(latest);
      },
      onComplete: () => {
        el.textContent = fmt(value);
      },
    });
    return () => {
      controls.stop();
      // Garante que nunca fica "parado no meio" ao desmontar/trocar valor.
      el.textContent = fmt(value);
    };
  }, [value, reduced, duration, fmt]);

  return (
    <span className={cn("tabular-nums", className)}>
      <span ref={visualRef} aria-hidden="true">
        {finalText}
      </span>
      <span className="sr-only" aria-live={live} aria-atomic="true">
        {finalText}
      </span>
    </span>
  );
}
