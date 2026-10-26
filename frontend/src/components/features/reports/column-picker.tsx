"use client";

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ReportColumn } from "@/lib/reports-api";
import { cn } from "@/lib/utils";

// =============================================================================
// Seleção das colunas do arquivo exportado. Checkboxes NATIVOS (fieldset +
// legend, um <label> por coluna, foco visível, teclado nativo). Apresentação
// apenas: o backend valida as chaves, o perfil e o que cada perfil pode ver.
// A ordem exibida é a do catálogo. `selected` é estado em memória (sem storage).
// =============================================================================

interface ColumnPickerProps {
  reportId: string;
  columns: ReportColumn[];
  selected: string[];
  disabled?: boolean;
  onChange: (keys: string[]) => void;
}

export function ColumnPicker({ reportId, columns, selected, disabled = false, onChange }: ColumnPickerProps) {
  const chosen = new Set(selected);
  const total = columns.length;
  const empty = selected.length === 0;
  const warningId = `rel-${reportId}-colunas-aviso`;

  function toggle(key: string, on: boolean) {
    // Mantém a ordem do catálogo.
    onChange(columns.filter((c) => (c.key === key ? on : chosen.has(c.key))).map((c) => c.key));
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 border-0 p-0"
      disabled={disabled}
      aria-describedby={empty ? warningId : undefined}
      data-testid="column-picker"
    >
      <legend className="mb-1 text-eyebrow text-pale-stone">Colunas do arquivo</legend>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-body-sm text-pale-stone" data-testid="column-count">
          {selected.length} de {total} selecionadas
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="min-h-8"
          disabled={disabled || selected.length === total}
          onClick={() => onChange(columns.map((c) => c.key))}
        >
          Marcar todas
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="min-h-8"
          disabled={disabled || empty}
          onClick={() => onChange([])}
        >
          Limpar
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {columns.map((column) => {
          const id = `rel-${reportId}-col-${column.key}`;
          const checked = chosen.has(column.key);
          return (
            <li key={column.key} className="relative max-w-full">
              <input
                id={id}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => toggle(column.key, event.target.checked)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className={cn(
                  "inline-flex min-h-9 max-w-full cursor-pointer items-center gap-2 rounded-buttons border px-[14px] py-1.5 text-body-sm transition-factory",
                  "peer-focus-visible:ring-1 peer-focus-visible:ring-bone peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-obsidian-canvas",
                  "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
                  checked ? "border-bone bg-carbon-lift text-bone" : "border-ash-stroke text-pale-stone hover:border-pale-stone",
                )}
              >
                <Check className={cn("size-4 shrink-0", checked ? "" : "invisible")} aria-hidden="true" />
                <span className="min-w-0 break-words">{column.label}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite" id={warningId} className="min-h-0">
        {empty ? (
          <p className="text-body-sm text-pale-stone" data-testid="column-warning">
            Selecione ao menos uma coluna para exportar.
          </p>
        ) : null}
      </div>
      <p className="text-caption text-warm-granite">
        As colunas disponíveis seguem o seu perfil. Datas e horas saem em UTC.
      </p>
    </fieldset>
  );
}
