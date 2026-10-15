"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listUnits, type UnitRef } from "@/lib/users-api";
import { userErrorMessage } from "./user-labels";

// =============================================================================
// Seletor de unidades por checkbox — fonte: `GET /api/v1/units` (unidades do
// escopo do ADM). Substitui o antigo campo de UUID livre. Checkbox nativo
// dentro de <label> (alvo >= 32px, WCAG 2.5.8); `fieldset/legend` dá o nome
// do grupo e o erro entra em aria-describedby. Quem decide o escopo é o
// backend (unidade alheia → 403 `unit_out_of_scope`).
// =============================================================================

export const UNITS_QUERY_KEY = ["units"] as const;

export function useUnits(enabled = true) {
  return useQuery({
    queryKey: UNITS_QUERY_KEY,
    queryFn: listUnits,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function unitLabel(unit: UnitRef): string {
  return unit.code ? `${unit.code} — ${unit.name}` : unit.name;
}

export interface UnitCheckboxListProps {
  legend: string;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string | null;
  hint?: string;
  surface?: "dark" | "light";
  className?: string;
  /** id do <fieldset> (para levar o foco ao 1º checkbox em caso de erro). */
  id?: string;
}

export function UnitCheckboxList({
  legend,
  selected,
  onChange,
  disabled = false,
  required = false,
  error,
  hint,
  surface = "dark",
  className,
  id: fieldsetId,
}: UnitCheckboxListProps) {
  const units = useUnits();
  const id = useId().replace(/:/g, "");
  const hintId = `${id}-dica`;
  const errorId = `${id}-erro`;
  const light = surface === "light";
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  function toggle(unitId: string, checked: boolean) {
    const set = new Set(selected);
    if (checked) set.add(unitId);
    else set.delete(unitId);
    onChange(Array.from(set));
  }

  return (
    <fieldset
      id={fieldsetId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
      aria-describedby={describedBy}
      data-testid="seletor-unidades"
    >
      <legend className={cn("mb-1.5 text-eyebrow", light ? "text-graphite-mid" : "text-pale-stone")}>
        {legend}
        {required ? (
          <span aria-hidden="true" className="ml-1">
            *
          </span>
        ) : null}
      </legend>
      {hint ? (
        <p id={hintId} className={cn("text-caption leading-[1.4]", light ? "text-graphite-mid" : "text-warm-granite")}>
          {hint}
        </p>
      ) : null}

      {units.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Carregando unidades…">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      ) : null}

      {units.isError ? (
        <div className="flex flex-col items-start gap-2">
          <FormMessage surface={surface}>
            {userErrorMessage(units.error, "Não foi possível carregar as unidades. Tente novamente.")}
          </FormMessage>
          <Button
            type="button"
            size="sm"
            variant={light ? "outlineOnLight" : "outline"}
            loading={units.isFetching}
            onClick={() => units.refetch()}
          >
            Tentar novamente
          </Button>
        </div>
      ) : null}

      {units.data ? (
        units.data.units.length === 0 ? (
          <p className={cn("text-body-sm", light ? "text-graphite-mid" : "text-warm-granite")}>
            Nenhuma unidade disponível no seu escopo.
          </p>
        ) : (
          <ul
            className={cn(
              "flex max-h-60 flex-col overflow-y-auto rounded-buttons border",
              light ? "border-graphite-mid/40" : "border-ash-stroke",
              error && "border-signal-orange",
            )}
          >
            {units.data.units.map((unit) => {
              const checked = selected.includes(unit.id);
              return (
                <li key={unit.id} className={cn("border-b last:border-b-0", light ? "border-graphite-mid/20" : "border-carbon-lift")}>
                  <label
                    className={cn(
                      "flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 text-body-sm transition-factory",
                      light ? "text-obsidian-canvas hover:bg-obsidian-canvas/5" : "text-bone hover:bg-carbon-lift/60",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      name="unit_ids"
                      value={unit.id}
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => toggle(unit.id, event.target.checked)}
                      className={cn(
                        "h-4 w-4 shrink-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-2 disabled:cursor-not-allowed",
                        light
                          ? "accent-obsidian-canvas focus-visible:ring-obsidian-canvas focus-visible:ring-offset-bone"
                          : "accent-bone focus-visible:ring-bone focus-visible:ring-offset-obsidian-canvas",
                      )}
                    />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{unitLabel(unit)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {error ? (
        <SlideIn distance="sm">
          <FormMessage id={errorId} surface={surface}>
            {error}
          </FormMessage>
        </SlideIn>
      ) : null}
    </fieldset>
  );
}
