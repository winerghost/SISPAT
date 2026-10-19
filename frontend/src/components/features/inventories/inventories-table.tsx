"use client";

import { AlertTriangle, Ban, Check, ClipboardList, FolderOpen, Play, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AnimatedTableBody,
  AnimatedTableRow,
  Table,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  InventoryItemResult,
  InventoryRecord,
  InventorySort,
  InventoryStatus,
} from "@/lib/inventories-api";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import { formatCalendarDate, formatDateTime, resultLabel, statusLabel } from "./inventory-labels";

// =============================================================================
// Tabela de inventários. Colunas priorizadas por largura (sem rolagem da página,
// 320 a 1920 px): até `md` só Inventário (com estado, unidade e início embaixo) +
// Detalhes; `md` soma Unidade e Estado; `lg` soma "Início"; `xl` soma "Criado em".
// Estado e resultado são SEMPRE ícone + texto. Não há editar/excluir: inventários
// são imutáveis. Datas em America/Araguaina; nenhum número é animado.
// =============================================================================

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";
const FROM_MD = "hidden md:table-cell";
const FROM_LG = "hidden lg:table-cell";
const FROM_XL = "hidden xl:table-cell";

const STATUS_ICON: Record<InventoryStatus, typeof Check> = {
  ABERTO: FolderOpen,
  EM_ANDAMENTO: Play,
  CONCLUIDO: Check,
  CANCELADO: Ban,
};

export function StatusBadge({ status, surface = "dark" }: { status: InventoryStatus; surface?: "dark" | "light" }) {
  const Icon = STATUS_ICON[status] ?? FolderOpen;
  if (surface === "light") {
    return (
      <Badge variant="default" className="border-graphite-mid text-obsidian-canvas">
        <Icon aria-hidden="true" />
        {statusLabel(status)}
      </Badge>
    );
  }
  const variant = status === "EM_ANDAMENTO" ? "warning" : status === "CONCLUIDO" ? "success" : "default";
  return (
    <Badge variant={variant}>
      <Icon aria-hidden="true" />
      {statusLabel(status)}
    </Badge>
  );
}

const RESULT_ICON: Record<InventoryItemResult, typeof Check> = {
  ENCONTRADO: Check,
  NAO_ENCONTRADO: X,
  DIVERGENTE: AlertTriangle,
};

/** Resultado derivado no servidor: ícone + texto (nunca só cor). */
export function ResultBadge({ result }: { result: InventoryItemResult }) {
  const Icon = RESULT_ICON[result] ?? AlertTriangle;
  const variant = result === "ENCONTRADO" ? "success" : result === "DIVERGENTE" ? "warning" : "default";
  return (
    <Badge variant={variant}>
      <Icon aria-hidden="true" />
      {resultLabel(result)}
    </Badge>
  );
}

export function InventoriesTable({
  inventories,
  sort,
  onSortChange,
  pageKey,
  busy,
  filtered,
  onOpen,
}: {
  inventories: InventoryRecord[];
  sort: InventorySort;
  onSortChange: (sort: InventorySort) => void;
  pageKey: string | number;
  busy: boolean;
  filtered: boolean;
  onOpen: (inventory: InventoryRecord) => void;
}) {
  return (
    <Table busy={busy} aria-label="Inventários">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Inventário" sort={sort} onSortChange={onSortChange} />
          <TableHead className={FROM_MD}>Unidade</TableHead>
          <SortableHead field="status" label="Estado" sort={sort} onSortChange={onSortChange} className={FROM_MD} />
          <SortableHead field="start_date" label="Início" sort={sort} onSortChange={onSortChange} className={FROM_LG} />
          <SortableHead field="created_at" label="Criado em" sort={sort} onSortChange={onSortChange} className={FROM_XL} />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {inventories.length === 0 ? (
          <TableEmpty
            colSpan={6}
            icon={ClipboardList}
            title={filtered ? "Nenhum inventário encontrado para os filtros atuais." : "Nenhum inventário no seu escopo."}
            description={
              filtered
                ? "Ajuste a busca ou limpe os filtros."
                : "Os inventários aparecem aqui. Um administrador cria e inicia cada campanha por unidade."
            }
          />
        ) : (
          inventories.map((inventory, index) => (
            <AnimatedTableRow key={inventory.id} index={index}>
              <TableCell className={cn("min-w-[9rem] align-top", WRAP)}>
                <span className="block">{inventory.name}</span>
                <span className="mt-1 flex flex-col gap-1 text-caption text-warm-granite md:hidden">
                  <span>
                    <StatusBadge status={inventory.status} />
                  </span>
                  <span>
                    <span translate="no">{inventory.unit?.code ?? "—"}</span> ·{" "}
                    {formatCalendarDate(inventory.start_date) ?? "—"}
                  </span>
                </span>
              </TableCell>
              <TableCell className={cn(FROM_MD, "align-top text-body-sm", WRAP)}>
                {inventory.unit ? (
                  <>
                    <span translate="no">{inventory.unit.code}</span> — {inventory.unit.name}
                  </>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className={cn(FROM_MD, "align-top")}>
                <StatusBadge status={inventory.status} />
              </TableCell>
              <TableCell className={cn(FROM_LG, "whitespace-nowrap align-top text-warm-granite")}>
                {formatCalendarDate(inventory.start_date) ?? "—"}
              </TableCell>
              <TableCell className={cn(FROM_XL, "whitespace-nowrap align-top text-warm-granite")}>
                {formatDateTime(inventory.created_at) ?? "—"}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(inventory)}
                    aria-label={`Ver detalhes do inventário ${inventory.name}, ${statusLabel(inventory.status)}`}
                  >
                    Detalhes
                  </Button>
                </div>
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}
