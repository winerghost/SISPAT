"use client";

import { ArrowLeftRight, Ban, Check, Clock, X } from "lucide-react";

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
import type { MovementRecord, MovementSort, MovementStatus } from "@/lib/movements-api";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import { PatrimonyNumber } from "@/components/features/assets/assets-table";
import { destinationOf, formatDateTime, originOf, statusLabel, typeLabel } from "./movement-labels";

// =============================================================================
// Tabela de movimentações. Colunas priorizadas por largura (sem rolagem da
// página, 320 a 1920 px): até `md` só Bem (com estado e De/Para embaixo) +
// Ações; `md` soma Movimento (De/Para) e Estado; `lg` soma "Solicitada em".
// O estado é SEMPRE ícone + texto. Não há ações de editar/excluir: o histórico
// é imutável. Datas em America/Araguaina; nenhum número é animado.
// =============================================================================

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";
const FROM_MD = "hidden md:table-cell";
const FROM_LG = "hidden lg:table-cell";

const STATUS_ICON: Record<MovementStatus, typeof Check> = {
  PENDENTE: Clock,
  APROVADA: Check,
  CONCLUIDA: Check,
  REJEITADA: X,
  CANCELADA: Ban,
};

export function StatusBadge({ status, surface = "dark" }: { status: MovementStatus; surface?: "dark" | "light" }) {
  const Icon = STATUS_ICON[status] ?? Clock;
  if (surface === "light") {
    return (
      <Badge variant="default" className="border-graphite-mid text-obsidian-canvas">
        <Icon aria-hidden="true" />
        {statusLabel(status)}
      </Badge>
    );
  }
  const variant = status === "PENDENTE" ? "warning" : status === "APROVADA" || status === "CONCLUIDA" ? "success" : "default";
  return (
    <Badge variant={variant}>
      <Icon aria-hidden="true" />
      {statusLabel(status)}
    </Badge>
  );
}

function FromTo({ movement }: { movement: MovementRecord }) {
  const from = originOf(movement);
  const to = destinationOf(movement);
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        <span className="text-warm-granite">De </span>
        <span translate="no">{movement.origin_unit?.code ?? "—"}</span> · {from.room}
      </span>
      <span>
        <span className="text-warm-granite">Para </span>
        <span translate="no">{movement.destination_unit?.code ?? "—"}</span> · {to.room}
      </span>
    </span>
  );
}

export function MovementsTable({
  movements,
  sort,
  onSortChange,
  pageKey,
  busy,
  filtered,
  onOpen,
}: {
  movements: MovementRecord[];
  sort: MovementSort;
  onSortChange: (sort: MovementSort) => void;
  pageKey: string | number;
  busy: boolean;
  filtered: boolean;
  onOpen: (movement: MovementRecord) => void;
}) {
  return (
    <Table busy={busy} aria-label="Movimentações">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <TableHead>Bem</TableHead>
          <TableHead className={FROM_MD}>Movimento</TableHead>
          <SortableHead field="status" label="Estado" sort={sort} onSortChange={onSortChange} className={FROM_MD} />
          <SortableHead
            field="created_at"
            label="Solicitada em"
            sort={sort}
            onSortChange={onSortChange}
            className={FROM_LG}
          />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {movements.length === 0 ? (
          <TableEmpty
            colSpan={5}
            icon={ArrowLeftRight}
            title={
              filtered ? "Nenhuma movimentação encontrada para os filtros atuais." : "Nenhuma movimentação no seu escopo."
            }
            description={
              filtered
                ? "Ajuste os filtros ou limpe-os."
                : "As solicitações aparecem aqui. Quem pode solicitar usa “Solicitar movimentação”."
            }
          />
        ) : (
          movements.map((movement, index) => (
            <AnimatedTableRow key={movement.id} index={index}>
              <TableCell className={cn("min-w-[9rem] align-top", WRAP)}>
                {movement.asset ? (
                  <>
                    <PatrimonyNumber value={movement.asset.patrimony_number} />
                    <span className="block text-body-sm">{movement.asset.description ?? "—"}</span>
                  </>
                ) : (
                  <span className="text-warm-granite">Bem indisponível</span>
                )}
                <span className="mt-1 block text-caption text-warm-granite">{typeLabel(movement.movement_type)}</span>
                <span className="mt-1 flex flex-col gap-1 text-caption md:hidden">
                  <span>
                    <StatusBadge status={movement.status} />
                  </span>
                  <FromTo movement={movement} />
                  <span className="text-warm-granite">{formatDateTime(movement.created_at) ?? "—"}</span>
                </span>
              </TableCell>
              <TableCell className={cn(FROM_MD, "min-w-[10rem] align-top text-body-sm", WRAP)}>
                <FromTo movement={movement} />
              </TableCell>
              <TableCell className={cn(FROM_MD, "align-top")}>
                <StatusBadge status={movement.status} />
              </TableCell>
              <TableCell className={cn(FROM_LG, "whitespace-nowrap align-top text-warm-granite")}>
                {formatDateTime(movement.created_at) ?? "—"}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(movement)}
                    aria-label={`Ver detalhes da movimentação do patrimônio ${movement.asset?.patrimony_number ?? "indisponível"}, ${statusLabel(movement.status)}`}
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
