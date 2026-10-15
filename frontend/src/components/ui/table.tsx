"use client";

import * as React from "react";

import { StaggerContainer, StaggerItem, type StaggerItemProps } from "@/components/animations";
import { EmptyState, type EmptyStateProps } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

// =============================================================================
// Table — primitivos semânticos (sem Radix: <table> nativo já é acessível).
// Pensado para ser consumido junto de @tanstack/react-table (headers/rows
// renderizados via flexRender nas páginas de listagem de patrimônios, etc.).
// Divisores hairline 1px (#1d1a18/ash-stroke), Geist Mono uppercase nos
// cabeçalhos de coluna — ver DESIGN.md > "Metric Tile" / "Dashboard Frame".
//
// Motion (DESIGN.md > Motion Philosophy): linhas trocam fundo em 150 ms
// (transition-factory) no hover E no foco de qualquer controle da linha
// (focus-within); `data-state="selected"` marca a linha selecionada.
// `AnimatedTableBody`/`AnimatedTableRow`: entrada escalonada fade + 4px só das
// primeiras 20 linhas (o resto aparece pronto); troque a `key` do body ao
// filtrar/paginar para reanimar. `busy`: esmaece a tabela (só opacity) e marca
// aria-busy enquanto a próxima página/filtro carrega.
// =============================================================================

const ROW_CLASSES =
  "border-b border-carbon-lift transition-factory hover:bg-carbon-lift/40 focus-within:bg-carbon-lift/40 data-[state=selected]:bg-carbon-lift";

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Carregando nova página/filtro com dados anteriores visíveis. */
  busy?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, busy = false, ...props }, ref) => (
    // `relative`: elementos absolutos internos (ex.: textos sr-only nos
    // cabeçalhos) ficam contidos na rolagem da tabela, nunca na da página.
    <div className="relative w-full overflow-x-auto">
      <table
        ref={ref}
        aria-busy={busy || undefined}
        className={cn(
          "w-full caption-bottom text-body-sm transition-opacity duration-base ease-factory",
          busy && "opacity-60",
          className,
        )}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("border-b border-ash-stroke", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t border-ash-stroke bg-carbon-lift/50 font-regular", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn(ROW_CLASSES, className)} {...props} />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-4 text-left align-middle text-eyebrow text-pale-stone [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("px-4 py-3 align-middle text-bone [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-body-sm text-warm-granite", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

/** <tbody> com entrada escalonada (limite padrão 20 linhas animadas). */
function AnimatedTableBody({
  className,
  limit = 20,
  children,
}: {
  className?: string;
  limit?: number;
  children: React.ReactNode;
}) {
  return (
    <StaggerContainer as="tbody" limit={limit} className={cn("[&_tr:last-child]:border-0", className)}>
      {children}
    </StaggerContainer>
  );
}

type AnimatedTableRowProps = Omit<StaggerItemProps, "as"> & {
  "data-state"?: "selected";
};

/** Linha de AnimatedTableBody (fade + 4px; `index` define o atraso). */
function AnimatedTableRow({ className, ...props }: AnimatedTableRowProps) {
  return <StaggerItem as="tr" className={cn(ROW_CLASSES, className)} {...props} />;
}

/** Linha única de estado vazio (EmptyState sem borda dentro da tabela). */
function TableEmpty({ colSpan, ...props }: EmptyStateProps & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <EmptyState variant="plain" {...props} />
      </td>
    </tr>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  AnimatedTableBody,
  AnimatedTableRow,
  TableEmpty,
};
