"use client";

import { useContext, useSyncExternalStore } from "react";
import { MotionConfigContext } from "motion/react";

// =============================================================================
// usePrefersReducedMotion — SSR-safe.
// =============================================================================
// O `useReducedMotion()` do Motion lê `matchMedia` no inicializador do
// useState: no cliente o 1º render pode devolver `true` enquanto o HTML do
// servidor foi gerado com `false` — se o JSX depender disso, há mismatch de
// hidratação. Aqui usamos `useSyncExternalStore` com snapshot de servidor
// `false`: durante a hidratação o React usa o snapshot do servidor e logo
// em seguida re-renderiza com o valor real, sem erro de hidratação, e o
// valor continua reagindo a mudanças da preferência do SO em tempo real.
//
// Também respeita `<MotionConfig reducedMotion="always" | "never">` quando
// configurado explicitamente acima na árvore ("user" = segue o SO).
// =============================================================================

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** `true` quando o usuário pediu menos movimento (ou MotionConfig força). */
export function usePrefersReducedMotion(): boolean {
  const { reducedMotion } = useContext(MotionConfigContext);
  const system = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (reducedMotion === "always") return true;
  if (reducedMotion === "never") return false;
  return system;
}

/** Alias com o nome do hook do Motion, para quem já conhece a API. */
export const useReducedMotion = usePrefersReducedMotion;
