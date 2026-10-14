"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * `true` quando a media query casa. SSR-safe: snapshot de servidor `false`
 * (o HTML do servidor e a hidratação concordam; o valor real entra no render
 * seguinte, sem mismatch).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
    () => false,
  );
}

/** Breakpoint `lg` do Tailwind (1024px). */
export const LG_QUERY = "(min-width: 1024px)";
