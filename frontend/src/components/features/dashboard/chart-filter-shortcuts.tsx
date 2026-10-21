"use client";

import { useId, useState } from "react";
import { ChevronDown, Filter } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FilterPill } from "@/components/ui/filter-pill";
import type { DashboardFilters } from "@/lib/dashboard-api";
import { cn } from "@/lib/utils";

import { useChartFocus } from "./chart-focus-context";
import { isPatchApplied, type FilterPatch } from "./dashboard-chart-filters";

// =============================================================================
// Alternativa ACESSÍVEL ao clique nas barras (o SVG do Nivo é aria-hidden e
// não recebe foco): disclosure "Filtrar pelo gráfico" com botões aria-pressed,
// um por item que tem filtro equivalente. Fechado por padrão (listas longas
// não empurram a página). Rótulos são texto (escape do React).
// =============================================================================

export interface ShortcutOption {
  key: string;
  label: string;
  patch: FilterPatch;
}

export interface ShortcutGroup {
  /** Nome do filtro ("Unidade de uso", "Localizado", "Sala"). */
  label: string;
  options: ShortcutOption[];
}

export function ChartFilterShortcuts({
  panelTitle,
  groups,
  filters,
  onFilter,
}: {
  panelTitle: string;
  groups: ShortcutGroup[];
  filters: DashboardFilters;
  onFilter: (patch: FilterPatch) => void;
}) {
  const baseId = useId().replace(/:/g, "");
  // Estado aberto guardado fora do bloco (sobrevive ao recarregamento após filtrar).
  const focus = useChartFocus();
  const [localOpen, setLocalOpen] = useState(false);
  const open = focus ? focus.isOpen(panelTitle) : localOpen;
  const setOpen = (next: boolean) => (focus ? focus.setOpen(panelTitle, next) : setLocalOpen(next));
  const usable = groups.filter((group) => group.options.length > 0);
  if (usable.length === 0) return null;
  const panelId = `atalhos-${baseId}`;

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-4 sm:px-5 print:hidden" data-chart-filter-shortcuts>
      <div data-focus-id="atalhos">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <Filter aria-hidden />
          Filtrar pelo gráfico
          <span className="sr-only">{` — ${panelTitle}`}</span>
          <ChevronDown aria-hidden className={cn("transition-factory", open && "rotate-180")} />
        </Button>
      </div>
      <div id={panelId} hidden={!open} className="flex min-w-0 flex-col gap-3">
        {open
          ? usable.map((group, index) => {
              const labelId = `${panelId}-g${index}`;
              return (
                <div key={group.label} className="flex min-w-0 flex-col gap-2">
                  <p id={labelId} className="text-eyebrow text-pale-stone">
                    {group.label}
                  </p>
                  <ul aria-labelledby={labelId} className="m-0 flex min-w-0 list-none flex-wrap gap-2 p-0">
                    {group.options.map((option) => (
                      <li
                        key={option.key}
                        data-focus-id={`atalho:${group.label}:${JSON.stringify(option.patch)}`}
                        className="min-w-0 max-w-full [overflow-wrap:anywhere]"
                      >
                        <FilterPill
                          label={option.label}
                          active={isPatchApplied(filters, option.patch)}
                          onClick={() => onFilter(option.patch)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
