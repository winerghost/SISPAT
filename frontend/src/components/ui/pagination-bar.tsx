"use client";

import { useId } from "react";

import { Button } from "@/components/ui/button";
import { selectControlClassName } from "@/components/ui/form-field";
import { PAGE_SIZE_OPTIONS, pageRange, totalPagesFor } from "@/lib/pagination";
import { cn } from "@/lib/utils";

// =============================================================================
// PaginationBar — barra de paginação padrão (server-side). Mostra "Exibindo
// X–Y de Z", seletor nativo "Registros por página" (50/100/200), e botões
// Primeira/Anterior/Próxima/Última. Tudo desabilitado em `busy`; limites
// desabilitam os botões. O resumo é aria-live="polite". Flex-wrap: sem rolagem
// horizontal de 320 a 1920px. Estado vem de `usePagination` (@/lib/pagination).
// =============================================================================

export interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Carregando: desabilita os controles. */
  busy?: boolean;
  /** Substantivo do resumo (padrão "registro(s)"). */
  noun?: string;
  /** Nome acessível da navegação (padrão "Paginação"). */
  label?: string;
  className?: string;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  busy = false,
  noun = "registro(s)",
  label = "Paginação",
  className,
}: PaginationBarProps) {
  const selectId = `page-size-${useId().replace(/:/g, "")}`;
  const totalPages = totalPagesFor(total, pageSize);
  const current = Math.min(Math.max(1, page), totalPages);
  const { from, to } = pageRange(current, pageSize, total);
  const atStart = current <= 1;
  const atEnd = current >= totalPages;

  return (
    <nav
      aria-label={label}
      aria-busy={busy || undefined}
      className={cn("flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between", className)}
    >
      <p className="text-body-sm text-warm-granite" role="status" aria-live="polite">
        {total === 0 ? `Nenhum ${noun}` : `Exibindo ${from}–${to} de ${total} ${noun}`}
        <span className="sr-only">
          {" "}
          · Página {current} de {totalPages}
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-eyebrow text-pale-stone">
            Registros por página
          </label>
          <select
            id={selectId}
            className={cn(selectControlClassName, "w-auto min-w-[5rem]")}
            value={PAGE_SIZE_OPTIONS.find((option) => option === pageSize) ?? PAGE_SIZE_OPTIONS[0]}
            disabled={busy}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={atStart || busy} onClick={() => onPageChange(1)}>
            Primeira
          </Button>
          <Button variant="outline" size="sm" disabled={atStart || busy} onClick={() => onPageChange(current - 1)}>
            Anterior
          </Button>
          <span className="text-body-sm text-pale-stone" aria-hidden="true">
            {current} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={atEnd || busy} onClick={() => onPageChange(current + 1)}>
            Próxima
          </Button>
          <Button variant="outline" size="sm" disabled={atEnd || busy} onClick={() => onPageChange(totalPages)}>
            Última
          </Button>
        </div>
      </div>
    </nav>
  );
}
