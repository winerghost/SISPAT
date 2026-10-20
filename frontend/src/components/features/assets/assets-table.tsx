"use client";

import { Archive, Check, CircleHelp, Package, X } from "lucide-react";

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
import type { AssetRecord, AssetSort, LocatedStatus } from "@/lib/assets-api";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import { formatDateTime, LOCATED_LABEL } from "./asset-labels";

// =============================================================================
// Tabela de bens. Colunas priorizadas por largura (sem rolagem da página, 320 a
// 1920 px): até `md` só Patrimônio + Descrição (com resumo de unidade e situação
// embaixo) + Ações; `md` soma Unidade e Localizado; `lg` soma Sala,
// Responsável e Vínculo (abaixo de `lg` o vínculo vai no resumo da descrição);
// `xl` soma "Atualizado em". O vínculo é texto importado: só texto, escapado. Chaves ausentes (ex.: RH) não geram
// coluna. O número patrimonial é TEXTO (`translate="no"`), nunca formatado.
// Ordenação só pelas colunas da allowlist do backend (inclui `bond_status`). Datas em America/Araguaina.
// =============================================================================

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";
const FROM_MD = "hidden md:table-cell";
const FROM_LG = "hidden lg:table-cell";
const FROM_XL = "hidden xl:table-cell";

export function PatrimonyNumber({ value, className }: { value: string; className?: string }) {
  return (
    <span translate="no" className={cn("font-mono text-body-sm [overflow-wrap:anywhere]", className)}>
      {value}
    </span>
  );
}

export function LocatedBadge({ located, surface = "dark" }: { located: LocatedStatus; surface?: "dark" | "light" }) {
  const icon =
    located === "SIM" ? <Check aria-hidden="true" /> : located === "NAO" ? <X aria-hidden="true" /> : <CircleHelp aria-hidden="true" />;
  if (surface === "light") {
    return (
      <Badge variant="default" className="border-graphite-mid text-obsidian-canvas">
        {icon}
        {LOCATED_LABEL[located]}
      </Badge>
    );
  }
  return (
    <Badge variant={located === "SIM" ? "success" : located === "NAO" ? "warning" : "default"}>
      {icon}
      {LOCATED_LABEL[located]}
    </Badge>
  );
}

/** Vínculo como TEXTO; vazio = "—" visual com rótulo acessível "sem vínculo". */
export function BondStatusText({ value }: { value: string | null | undefined }) {
  if (!value) {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">sem vínculo</span>
      </>
    );
  }
  return <>{value}</>;
}

export function DeletedBadge({ surface = "dark" }: { surface?: "dark" | "light" }) {
  return (
    <Badge variant="warning" className={surface === "light" ? "border-graphite-mid text-obsidian-canvas" : undefined}>
      <Archive aria-hidden="true" />
      Excluído
    </Badge>
  );
}

export function AssetsTable({
  assets,
  sort,
  onSortChange,
  pageKey,
  busy,
  filtered,
  onOpen,
}: {
  assets: AssetRecord[];
  sort: AssetSort;
  onSortChange: (sort: AssetSort) => void;
  pageKey: string | number;
  busy: boolean;
  filtered: boolean;
  onOpen: (asset: AssetRecord) => void;
}) {
  return (
    <Table busy={busy} aria-label="Patrimônios">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="patrimony_number" label="Patrimônio" sort={sort} onSortChange={onSortChange} />
          <SortableHead field="description" label="Descrição" sort={sort} onSortChange={onSortChange} />
          <TableHead className={FROM_MD}>Unidade</TableHead>
          <TableHead className={FROM_LG}>Sala</TableHead>
          <TableHead className={FROM_LG}>Responsável</TableHead>
          <SortableHead
            field="bond_status"
            label="Vínculo"
            sort={sort}
            onSortChange={onSortChange}
            className={FROM_LG}
          />
          <TableHead className={FROM_MD}>Localizado</TableHead>
          <SortableHead
            field="updated_at"
            label="Atualizado em"
            sort={sort}
            onSortChange={onSortChange}
            className={FROM_XL}
          />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {assets.length === 0 ? (
          <TableEmpty
            colSpan={9}
            icon={Package}
            title={filtered ? "Nenhum bem encontrado para os filtros atuais." : "Nenhum bem no seu escopo."}
            description={
              filtered
                ? "Ajuste a busca ou limpe os filtros."
                : "Os bens vêm da importação e do cadastro; o acesso às unidades é concedido por um administrador."
            }
          />
        ) : (
          assets.map((asset, index) => (
            <AnimatedTableRow key={asset.id} index={index}>
              <TableCell className="min-w-[7rem] align-top">
                <PatrimonyNumber value={asset.patrimony_number} />
                {asset.deleted_at ? (
                  <span className="mt-1 block">
                    <DeletedBadge />
                  </span>
                ) : null}
              </TableCell>
              <TableCell className={cn("min-w-[9rem] align-top", WRAP)}>
                <span className="block">{asset.description ?? "—"}</span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-warm-granite md:hidden">
                  <span translate="no">{asset.unit.code}</span>
                  <LocatedBadge located={asset.located} />
                </span>
                <span className="mt-1 block text-caption text-warm-granite lg:hidden">
                  Vínculo: <BondStatusText value={asset.bond_status} />
                </span>
              </TableCell>
              <TableCell className={cn(FROM_MD, "min-w-[8rem] align-top text-body-sm", WRAP)}>
                <span translate="no">{asset.unit.code}</span>
                <span className="block text-caption text-warm-granite">{asset.unit.name}</span>
              </TableCell>
              <TableCell className={cn(FROM_LG, "align-top text-body-sm", WRAP)}>{asset.room?.name ?? "—"}</TableCell>
              <TableCell className={cn(FROM_LG, "align-top text-body-sm", WRAP)}>
                {asset.responsible_person?.name ?? "—"}
              </TableCell>
              <TableCell className={cn(FROM_LG, "align-top text-body-sm", WRAP)}>
                <BondStatusText value={asset.bond_status} />
              </TableCell>
              <TableCell className={cn(FROM_MD, "align-top")}>
                <LocatedBadge located={asset.located} />
              </TableCell>
              <TableCell className={cn(FROM_XL, "whitespace-nowrap align-top text-warm-granite")}>
                {formatDateTime(asset.updated_at) ?? "—"}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(asset)}
                    aria-label={`Ver detalhes do patrimônio ${asset.patrimony_number}`}
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
