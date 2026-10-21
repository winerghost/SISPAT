"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";

import { FadeIn } from "@/components/animations";
import {
  DASHBOARD_CHART_OPTIONS,
  DEFAULT_DASHBOARD_CHARTS,
  type DashboardChartPanel,
  type DashboardChartType,
} from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

// =============================================================================
// Seletor discreto do tipo de gráfico de um painel (menu de opção única).
// Padrão WAI-ARIA "menu button": botão com aria-haspopup/expanded, menu com
// role="menu", itens role="menuitemradio" e a ação "Restaurar padrão".
// Teclado: Enter/Espaço/Seta abrem; Setas/Home/End navegam; Esc fecha e devolve
// o foco ao botão; Tab fecha. Alvos >= 44px no celular, foco visível, tema
// Factory dark (tokens do DESIGN.md), sem sombra. A escolha só vira a
// exibida DEPOIS de o backend confirmar (o pai controla `value`).
// Ocupado (`busy`, aria-disabled): clique, Enter, Espaço e setas não abrem o
// menu; o estado aberto é derivado (`requestedOpen && !busy`) e um menu aberto
// fecha se o salvamento começar. (Obs. de teste: o `locator.click()` do
// Playwright ADIA o clique em elemento aria-disabled até ele habilitar — por
// isso o e2e clica pelas coordenadas do ponteiro, sem `force`.)
// =============================================================================

export const CHART_TYPE_LABELS: { [P in DashboardChartPanel]: Record<DashboardChartType<P>, string> } = {
  units: { grouped: "Barras agrupadas", stacked: "Barras empilhadas", horizontal: "Barras horizontais" },
  status: { pie: "Pizza", donut: "Rosca", bar: "Barras" },
  monthly: { line: "Linhas", area: "Área", bar: "Barras" },
  location: { stacked: "Barras empilhadas", grouped: "Barras agrupadas", horizontal: "Barras horizontais" },
  bond: { pie: "Pizza", donut: "Rosca", bar: "Barras" },
  rooms: { bar: "Barras verticais", horizontal: "Barras horizontais" },
};

export interface ChartTypeMenuProps<P extends DashboardChartPanel> {
  panel: P;
  /** Nome do painel, para o nome acessível ("Bens por unidade"). */
  panelTitle: string;
  /** Tipo confirmado pelo backend (o gráfico exibido). */
  value: DashboardChartType<P>;
  /** Há um PATCH em andamento (qualquer painel): bloqueia nova escolha. */
  busy: boolean;
  /** Este painel é o que está salvando (mostra o indicador). */
  saving: boolean;
  onSelect: (value: DashboardChartType<P>) => void;
  onRestore: () => void;
}

export function ChartTypeMenu<P extends DashboardChartPanel>({
  panel,
  panelTitle,
  value,
  busy,
  saving,
  onSelect,
  onRestore,
}: ChartTypeMenuProps<P>) {
  const baseId = useId();
  const buttonId = `${baseId}-btn`;
  const menuId = `${baseId}-menu`;
  const [requestedOpen, setRequestedOpen] = useState(false);
  // Enquanto houver salvamento (aria-disabled), o menu NUNCA é exibido: o
  // estado aberto é derivado (não depende de o clique/tecla ter sido barrado
  // a tempo) e, se ficar ocupado com o menu aberto, ele é fechado.
  const open = requestedOpen && !busy;
  useEffect(() => {
    if (busy) setRequestedOpen(false);
  }, [busy]);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const options = DASHBOARD_CHART_OPTIONS[panel] as readonly DashboardChartType<P>[];
  const labels = CHART_TYPE_LABELS[panel] as Record<string, string>;
  const isDefault = value === DEFAULT_DASHBOARD_CHARTS[panel];
  const restoreIndex = options.length;

  const focusItem = (index: number) => {
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled);
    const target = itemRefs.current[index];
    (target && !target.disabled ? target : enabled[0])?.focus();
  };

  // Ao abrir, foco no item atual (ou no primeiro).
  useEffect(() => {
    if (open) focusItem(Math.max(0, options.indexOf(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Clique fora fecha (sem tirar o foco do que o usuário clicou).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setRequestedOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = (returnFocus: boolean) => {
    setRequestedOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const opener = event.key === "ArrowDown" || event.key === "ArrowUp";
    const activator = event.key === "Enter" || event.key === " ";
    if (busy && (opener || activator)) {
      // aria-disabled: nenhuma tecla abre o menu (nem o "click" sintético do Enter/Espaço).
      event.preventDefault();
      return;
    }
    if (opener) {
      event.preventDefault();
      setRequestedOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = itemRefs.current
      .map((el, index) => ({ el, index }))
      .filter((entry): entry is { el: HTMLButtonElement; index: number } => !!entry.el && !entry.el.disabled);
    const current = enabled.findIndex((entry) => entry.el === document.activeElement);
    const move = (next: number) => {
      event.preventDefault();
      enabled[(next + enabled.length) % enabled.length]?.el.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        move(current + 1);
        break;
      case "ArrowUp":
        move(current - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(enabled.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        setRequestedOpen(false);
        break;
      default:
    }
  };

  const itemClass = cn(
    "flex min-h-11 w-full items-center gap-2 rounded-nav px-3 text-left text-body-sm text-bone sm:min-h-9",
    "transition-factory hover:bg-obsidian-canvas focus-visible:bg-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
    "disabled:pointer-events-none disabled:opacity-50",
  );

  return (
    <div ref={rootRef} className="relative print:hidden" data-chart-type-menu={panel}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={saving || undefined}
        aria-disabled={busy || undefined}
        onClick={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          setRequestedOpen((current) => !current);
        }}
        onKeyDown={onButtonKeyDown}
        className={cn(
          "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-buttons border border-ash-stroke px-3 text-caption text-pale-stone sm:min-h-8",
          "transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
          "aria-disabled:opacity-60",
        )}
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin-slow" aria-hidden="true" />
        ) : (
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        )}
        <span className="sr-only sm:not-sr-only">Tipo de gráfico</span>
        <span className="sr-only">
          {` — ${panelTitle}, atual: ${labels[value]}`}
        </span>
        <ChevronDown className="hidden h-4 w-4 sm:block" aria-hidden="true" />
      </button>

      {open && (
        <FadeIn
          className="absolute right-0 top-full z-20 mt-1 w-[min(15rem,calc(100vw-2rem))] rounded-cards border border-ash-stroke bg-carbon-lift p-1"
        >
          <div
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            onKeyDown={onMenuKeyDown}
            className="flex flex-col"
          >
            {options.map((option, index) => (
              <button
                key={option}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={option === value}
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  close(true);
                  if (option !== value) onSelect(option);
                }}
              >
                <Check
                  className={cn("h-4 w-4 shrink-0", option === value ? "opacity-100" : "opacity-0")}
                  aria-hidden="true"
                />
                {labels[option]}
              </button>
            ))}
            <div role="separator" className="my-1 h-px bg-ash-stroke" />
            <button
              ref={(el) => {
                itemRefs.current[restoreIndex] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={isDefault}
              className={itemClass}
              onClick={() => {
                close(true);
                onRestore();
              }}
            >
              <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
              Restaurar padrão
            </button>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
