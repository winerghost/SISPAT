"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, DoorOpen, Building2, Users } from "lucide-react";

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
import type { PersonRecord, RoomRecord, PersonSort, RoomSort, UnitCatalogItem, UnitSort } from "@/lib/catalog-api";
import type { UnitRef } from "@/lib/users-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import { formatDateTime, maskPhone } from "./catalog-labels";
import { ActiveBadge, unitText } from "./catalog-parts";

// =============================================================================
// Tabelas dos cadastros de apoio. Ordenação só pelas colunas da allowlist do
// backend (aria-sort + botão nativo). A tabela rola na horizontal DENTRO do
// contêiner (Table) — nunca a página. Situação com ícone + texto. Datas em
// America/Araguaina. Telefone: só máscara (últimos 4 dígitos), e a coluna só
// existe se o backend enviou a chave `phone`.
// =============================================================================

export function SortableHead<TSort extends string>({
  field,
  label,
  sort,
  onSortChange,
  className,
}: {
  field: string;
  label: string;
  sort: TSort;
  onSortChange: (sort: TSort) => void;
  className?: string;
}) {
  const ascending = sort === field;
  const descending = sort === `-${field}`;
  const Icon = ascending ? ArrowUp : descending ? ArrowDown : ArrowUpDown;
  const next = (ascending ? `-${field}` : field) as TSort;
  return (
    <TableHead className={className} aria-sort={ascending ? "ascending" : descending ? "descending" : "none"}>
      <button
        type="button"
        onClick={() => onSortChange(next)}
        className={cn(
          "relative -mx-1 inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-buttons px-1 uppercase transition-factory hover:text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
          (ascending || descending) && "text-bone",
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">
          {ascending
            ? "(crescente; ativar para decrescente)"
            : descending
              ? "(decrescente; ativar para crescente)"
              : "(ativar para ordenar)"}
        </span>
      </button>
    </TableHead>
  );
}

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";

function RowActions({
  name,
  active,
  onEdit,
  onToggle,
}: {
  name: string;
  active: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Editar ${name}`}>
        Editar
      </Button>
      <Button variant="outline" size="sm" onClick={onToggle} aria-label={`${active ? "Inativar" : "Reativar"} ${name}`}>
        {active ? "Inativar" : "Reativar"}
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Salas
// -----------------------------------------------------------------------------

export function RoomsTable({
  rooms,
  units,
  pageKey,
  busy,
  sort,
  onSortChange,
  filtered,
  onEdit,
  onToggle,
}: {
  rooms: RoomRecord[];
  units: UnitRef[] | undefined;
  pageKey: string | number;
  busy: boolean;
  sort: RoomSort;
  onSortChange: (sort: RoomSort) => void;
  filtered: boolean;
  onEdit: (room: RoomRecord) => void;
  onToggle: (room: RoomRecord) => void;
}) {
  return (
    <Table busy={busy} aria-label="Salas">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          <TableHead>Unidade</TableHead>
          <TableHead>Andar</TableHead>
          <TableHead>Situação</TableHead>
          <SortableHead field="updated_at" label="Atualizada em" sort={sort} onSortChange={onSortChange} />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {rooms.length === 0 ? (
          <TableEmpty
            colSpan={6}
            icon={DoorOpen}
            title={filtered ? "Nenhuma sala encontrada para os filtros atuais." : "Nenhuma sala cadastrada."}
            description={filtered ? "Ajuste a busca ou limpe os filtros." : "Use “Nova sala” para cadastrar a primeira."}
          />
        ) : (
          rooms.map((room, index) => (
            <AnimatedTableRow key={room.id} index={index}>
              <TableCell className="min-w-[12rem]">
                <span className={WRAP}>{room.name}</span>
                {room.description ? (
                  <span className={cn("mt-0.5 block text-caption text-warm-granite", WRAP)}>{room.description}</span>
                ) : null}
              </TableCell>
              <TableCell className={cn("min-w-[10rem] text-body-sm", WRAP)}>{unitText(room.unit_id, units)}</TableCell>
              <TableCell className="text-warm-granite">{room.floor ?? "—"}</TableCell>
              <TableCell>
                <ActiveBadge active={room.active} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-warm-granite">
                {formatDateTime(room.updated_at) ?? "—"}
              </TableCell>
              <TableCell>
                <RowActions
                  name={room.name}
                  active={room.active}
                  onEdit={() => onEdit(room)}
                  onToggle={() => onToggle(room)}
                />
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Pessoas responsáveis
// -----------------------------------------------------------------------------

export function PeopleTable({
  people,
  units,
  pageKey,
  busy,
  sort,
  onSortChange,
  filtered,
  onEdit,
  onToggle,
}: {
  people: PersonRecord[];
  units: UnitRef[] | undefined;
  pageKey: string | number;
  busy: boolean;
  sort: PersonSort;
  onSortChange: (sort: PersonSort) => void;
  filtered: boolean;
  onEdit: (person: PersonRecord) => void;
  onToggle: (person: PersonRecord) => void;
}) {
  // Dado pessoal: a coluna só existe se o backend enviou a chave.
  const showPhone = people.some((person) => "phone" in person);
  const columns = showPhone ? 7 : 6;
  return (
    <Table busy={busy} aria-label="Pessoas responsáveis">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          <SortableHead field="email" label="E-mail" sort={sort} onSortChange={onSortChange} />
          {showPhone ? <TableHead>Telefone</TableHead> : null}
          <TableHead>Unidade</TableHead>
          <TableHead>Identificador</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {people.length === 0 ? (
          <TableEmpty
            colSpan={columns}
            icon={Users}
            title={filtered ? "Nenhuma pessoa encontrada para os filtros atuais." : "Nenhuma pessoa responsável cadastrada."}
            description={
              filtered ? "Ajuste a busca ou limpe os filtros." : "Use “Nova pessoa” para cadastrar a primeira."
            }
          />
        ) : (
          people.map((person, index) => (
            <AnimatedTableRow key={person.id} index={index}>
              <TableCell className={cn("min-w-[12rem]", WRAP)}>{person.name}</TableCell>
              <TableCell className={cn("min-w-[12rem] text-warm-granite", WRAP)}>{person.email ?? "—"}</TableCell>
              {showPhone ? (
                <TableCell className="whitespace-nowrap text-warm-granite" data-testid="telefone-mascarado">
                  {maskPhone(person.phone)}
                </TableCell>
              ) : null}
              <TableCell className={cn("min-w-[10rem] text-body-sm", WRAP)}>{unitText(person.unit_id, units)}</TableCell>
              <TableCell className={cn("text-warm-granite", WRAP)}>{person.institutional_identifier ?? "—"}</TableCell>
              <TableCell>
                <ActiveBadge active={person.active} feminine={false} />
              </TableCell>
              <TableCell>
                <RowActions
                  name={person.name}
                  active={person.active}
                  onEdit={() => onEdit(person)}
                  onToggle={() => onToggle(person)}
                />
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Unidades (`GET /units/catalog`: ativas e inativas, busca/ordenação no servidor)
// -----------------------------------------------------------------------------

export function UnitsTable({
  units,
  pageKey,
  busy,
  sort,
  onSortChange,
  filtered,
  onEdit,
  onToggle,
}: {
  units: UnitCatalogItem[];
  pageKey: string | number;
  busy: boolean;
  sort: UnitSort;
  onSortChange: (sort: UnitSort) => void;
  filtered: boolean;
  onEdit: (unit: UnitCatalogItem) => void;
  onToggle: (unit: UnitCatalogItem) => void;
}) {
  return (
    <Table busy={busy} aria-label="Unidades">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="code" label="Sigla" sort={sort} onSortChange={onSortChange} />
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          <TableHead>Situação</TableHead>
          <SortableHead field="updated_at" label="Atualizada em" sort={sort} onSortChange={onSortChange} />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {units.length === 0 ? (
          <TableEmpty
            colSpan={5}
            icon={Building2}
            title={filtered ? "Nenhuma unidade encontrada para os filtros atuais." : "Nenhuma unidade no seu escopo."}
            description={filtered ? "Ajuste a busca ou limpe os filtros." : "Unidades vêm da importação e do vínculo de acesso."}
          />
        ) : (
          units.map((unit, index) => (
            <AnimatedTableRow key={unit.id} index={index}>
              <TableCell className="whitespace-nowrap text-eyebrow">{unit.code}</TableCell>
              <TableCell className={cn("min-w-[14rem]", WRAP)}>{unit.name}</TableCell>
              <TableCell>
                <ActiveBadge active={unit.active} feminine />
              </TableCell>
              <TableCell className="whitespace-nowrap text-warm-granite">
                {formatDateTime(unit.updated_at) ?? "—"}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => onEdit(unit)} aria-label={`Gerenciar ${unitLabel(unit)}`}>
                    Gerenciar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onToggle(unit)}
                    aria-label={`${unit.active ? "Inativar" : "Reativar"} ${unitLabel(unit)}`}
                  >
                    {unit.active ? "Inativar" : "Reativar"}
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
