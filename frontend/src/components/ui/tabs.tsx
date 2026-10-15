"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { FadeIn } from "@/components/animations";
import { cn } from "@/lib/utils";

// =============================================================================
// Tabs — padrão WAI-ARIA APG (tablist/tab/tabpanel) com elementos nativos, sem
// dependência nova (plano A10). Ativação automática; setas ←/→ e Home/End
// movem o foco (tabindex itinerante); só o painel ativo é montado.
// Visual: Geist Mono 12px uppercase (voz "instrumento"), sublinhado bone de
// 1px na aba ativa, troca de cor em 150 ms; o painel entra com fade (200 ms,
// desligado sob prefers-reduced-motion pela fundação de animações).
// Alvos >= 32px de altura (WCAG 2.5.8). A lista rola na horizontal dentro de
// si mesma em telas estreitas — nunca a página.
// =============================================================================

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export interface TabsProps<T extends string> {
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs<T extends string>({ label, items, value, onValueChange, children, className }: TabsProps<T>) {
  const baseId = useId().replace(/:/g, "");
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (id: T) => `${baseId}-aba-${id}`;
  const panelId = (id: T) => `${baseId}-painel-${id}`;

  function focusTab(index: number) {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onValueChange(item.id);
    refs.current.get(item.id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: items.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    focusTab(next);
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)}>
      <div
        role="tablist"
        aria-label={label}
        className="-mx-1 flex min-w-0 gap-1 overflow-x-auto border-b border-ash-stroke px-1"
      >
        {items.map((item, index) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) refs.current.set(item.id, node);
                else refs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={selected}
              aria-controls={panelId(item.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "-mb-px inline-flex min-h-9 shrink-0 items-center whitespace-nowrap border-b px-3 text-eyebrow transition-factory",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bone",
                selected ? "border-bone text-bone" : "border-transparent text-warm-granite hover:text-bone",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <FadeIn
        key={value}
        role="tabpanel"
        id={panelId(value)}
        aria-labelledby={tabId(value)}
        // Sem tabIndex: todo painel aqui tem controles focáveis (APG só pede
        // tabindex=0 no painel quando ele não tem conteúdo focável).
        className="flex min-w-0 flex-col gap-6"
      >
        {children}
      </FadeIn>
    </div>
  );
}
