"use client";

import { useId } from "react";

import { cn } from "@/lib/utils";

// =============================================================================
// OptionRadioGroup — grupo de <input type="radio"> NATIVOS estilizados como
// cartões (sem dependência nova, plano A10). Mesmo padrão do Switch: o próprio
// input é o alvo (cobre o cartão inteiro, WCAG 2.5.8) e recebe o foco visível;
// o conteúdo é decorativo para o ponteiro (pointer-events-none) mas o <label
// for> dá o nome acessível e a descrição entra em aria-describedby.
// Estado nunca só por cor: o marcador circular interno também muda.
// =============================================================================

export interface RadioOption<T extends string | number> {
  value: T;
  label: string;
  description: string;
}

export interface OptionRadioGroupProps<T extends string | number> {
  legend: string;
  name: string;
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

export function OptionRadioGroup<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: OptionRadioGroupProps<T>) {
  const baseId = useId().replace(/:/g, "");
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-3", className)}>
      <legend className="mb-3 text-eyebrow text-pale-stone">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {options.map((option) => {
          const id = `${baseId}-${name}-${option.value}`;
          return (
            <div key={option.value} className="relative flex min-h-[88px] rounded-cards">
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={disabled}
                aria-describedby={`${id}-descricao`}
                onChange={() => onChange(option.value)}
                className={cn(
                  "peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-cards border border-ash-stroke bg-transparent transition-factory",
                  "hover:border-graphite-mid checked:border-bone",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              />
              <div className="pointer-events-none relative flex min-w-0 flex-1 gap-3 p-4 peer-disabled:opacity-50">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-factory",
                    value === option.value ? "border-bone" : "border-warm-granite",
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full bg-bone transition-opacity duration-fast motion-reduce:transition-none",
                      value === option.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={id} className="text-body-sm text-bone">
                    {option.label}
                  </label>
                  <span id={`${id}-descricao`} className="text-caption leading-[1.4] text-warm-granite">
                    {option.description}
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
