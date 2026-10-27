"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// =============================================================================
// Matriz de dados (linha × colunas) com DUAS apresentações do MESMO conteúdo:
//  - tabela semântica a partir de `lg` (rolagem só DENTRO da região da tabela,
//    focável por teclado e com nome; a página nunca rola na horizontal);
//  - lista de cartões abaixo de `lg` (1 coluna no celular, 2 no tablet).
// As células chegam prontas (texto): nada é calculado aqui. A que não é
// exibida fica com display:none (fora da árvore de acessibilidade).
// =============================================================================

export interface MatrixColumn {
  id: string;
  label: string;
}

export interface MatrixRow {
  key: string;
  label: string;
  /** Texto por coluna (mesma ordem de `columns`). */
  cells: string[];
}

export interface DataMatrixProps {
  /** Nome da tabela (caption sr-only e nome da região rolável). */
  caption: string;
  /** Cabeçalho da primeira coluna (ex.: "Unidade"). */
  rowHeader: string;
  columns: MatrixColumn[];
  rows: MatrixRow[];
  className?: string;
}

export function DataMatrix({ caption, rowHeader, columns, rows, className }: DataMatrixProps) {
  return (
    <div className={cn("min-w-0", className)} data-equipment-matrix>
      <div className="hidden lg:block">
        <Table regionLabel={`${caption} (rolável)`}>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{rowHeader}</TableHead>
              {columns.map((column) => (
                <TableHead key={column.id} scope="col" className="text-right">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <th scope="row" className="px-4 py-[var(--density-cell-y)] text-left align-middle font-regular break-words text-bone">
                  {row.label}
                </th>
                {row.cells.map((cell, i) => (
                  <TableCell key={columns[i]?.id ?? i} className="text-right tabular-nums">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label={caption} className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:hidden">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 rounded-cards border border-carbon-lift p-3">
            <p className="break-words text-body-sm text-bone">{row.label}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {row.cells.map((cell, i) => (
                <div key={columns[i]?.id ?? i} className="flex min-w-0 flex-col">
                  <dt className="text-caption text-warm-granite">{columns[i]?.label}</dt>
                  <dd className="m-0 text-body-sm tabular-nums text-bone">{cell}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
