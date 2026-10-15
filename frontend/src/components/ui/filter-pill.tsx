"use client";

import { cn } from "@/lib/utils";

// =============================================================================
// FilterPill — botão de filtro com `aria-pressed` (estado anunciado, não só
// visual). Geist Mono uppercase 12px, borda hairline; ativo = borda/texto
// bone. Cor/borda trocam em 150 ms. min-h-8 (32px): alvo >= 24px (WCAG 2.5.8).
// Use dentro de um `role="group"` com `aria-label` descrevendo o filtro.
// =============================================================================

export function FilterPill({
  label,
  active,
  onClick,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-8 items-center rounded-buttons border px-3 py-1 text-caption uppercase tracking-tight transition-factory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas disabled:opacity-50",
        active
          ? "border-bone text-bone"
          : "border-ash-stroke text-warm-granite hover:border-chalk hover:text-chalk",
      )}
    >
      {label}
    </button>
  );
}
