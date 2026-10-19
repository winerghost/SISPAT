"use client";

import { Building2, DoorOpen, Users } from "lucide-react";

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
import type { AccessibleUnit, PersonRecord, PersonSort, RoomRecord, RoomSort, UnitSort } from "@/lib/catalog-api";
import { formatDateTime, maskPhone } from "@/components/features/catalog/catalog-labels";
import { ActiveBadge } from "@/components/features/catalog/catalog-parts";
import { SortableHead } from "@/components/features/catalog/catalog-tables";
import { hasKey, lookupUnitText } from "./lookup-labels";

// =============================================================================
// Tabelas SOMENTE LEITURA (sem ações). Colunas opcionais só existem se o
// backend enviou a chave: para USER, pessoas chegam só com `id,name,unit_id,
// active`; `phone` (quando vem) é exibido mascarado. A tabela rola na horizontal
// dentro do contêiner — nunca a página. Situação com ícone + texto.
// =============================================================================

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";

type Loose<T> = Partial<T> & { id: string };

interface CommonProps {
  pageKey: string | number;
  busy: boolean;
  filtered: boolean;
  units: AccessibleUnit[] | undefined;
}

// Salas -------------------------------------------------------------------------

export function RoomsReadTable({
  rooms,
  sort,
  onSortChange,
  pageKey,
  busy,
  filtered,
  units,
}: CommonProps & { rooms: Loose<RoomRecord>[]; sort: RoomSort; onSortChange: (sort: RoomSort) => void }) {
  const showUnit = hasKey(rooms, "unit_id");
  const showFloor = hasKey(rooms, "floor");
  const showActive = hasKey(rooms, "active");
  const showUpdated = hasKey(rooms, "updated_at");
  const columns = 1 + [showUnit, showFloor, showActive, showUpdated].filter(Boolean).length;
  return (
    <Table busy={busy} aria-label="Salas">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          {showUnit ? <TableHead>Unidade</TableHead> : null}
          {showFloor ? <TableHead>Andar</TableHead> : null}
          {showActive ? <TableHead>Situação</TableHead> : null}
          {showUpdated ? (
            <SortableHead field="updated_at" label="Atualizada em" sort={sort} onSortChange={onSortChange} />
          ) : null}
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {rooms.length === 0 ? (
          <TableEmpty
            colSpan={columns}
            icon={DoorOpen}
            title={filtered ? "Nenhuma sala encontrada para os filtros atuais." : "Nenhuma sala no seu escopo."}
            description={filtered ? "Ajuste a busca ou limpe os filtros." : "As salas vêm do cadastro e da importação."}
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
              {showUnit ? (
                <TableCell className={cn("min-w-[10rem] text-body-sm", WRAP)}>
                  {lookupUnitText(room.unit_id, units)}
                </TableCell>
              ) : null}
              {showFloor ? <TableCell className="text-warm-granite">{room.floor ?? "—"}</TableCell> : null}
              {showActive ? (
                <TableCell>{room.active === undefined ? "—" : <ActiveBadge active={room.active} />}</TableCell>
              ) : null}
              {showUpdated ? (
                <TableCell className="whitespace-nowrap text-warm-granite">
                  {formatDateTime(room.updated_at) ?? "—"}
                </TableCell>
              ) : null}
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}

// Pessoas responsáveis ----------------------------------------------------------

export function PeopleReadTable({
  people,
  sort,
  onSortChange,
  pageKey,
  busy,
  filtered,
  units,
}: CommonProps & { people: Loose<PersonRecord>[]; sort: PersonSort; onSortChange: (sort: PersonSort) => void }) {
  const showEmail = hasKey(people, "email");
  const showPhone = people.some((person) => "phone" in person); // dado pessoal: nunca por padrão
  const showUnit = hasKey(people, "unit_id");
  const showIdentifier = hasKey(people, "institutional_identifier");
  const showActive = hasKey(people, "active");
  const columns = 1 + [showEmail, showPhone, showUnit, showIdentifier, showActive].filter(Boolean).length;
  return (
    <Table busy={busy} aria-label="Pessoas responsáveis">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          {showEmail ? <SortableHead field="email" label="E-mail" sort={sort} onSortChange={onSortChange} /> : null}
          {showPhone ? <TableHead>Telefone</TableHead> : null}
          {showUnit ? <TableHead>Unidade</TableHead> : null}
          {showIdentifier ? <TableHead>Identificador</TableHead> : null}
          {showActive ? <TableHead>Situação</TableHead> : null}
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {people.length === 0 ? (
          <TableEmpty
            colSpan={columns}
            icon={Users}
            title={
              filtered ? "Nenhuma pessoa encontrada para os filtros atuais." : "Nenhuma pessoa responsável no seu escopo."
            }
            description={filtered ? "Ajuste a busca ou limpe os filtros." : "As pessoas vêm do cadastro e da importação."}
          />
        ) : (
          people.map((person, index) => (
            <AnimatedTableRow key={person.id} index={index}>
              <TableCell className={cn("min-w-[12rem]", WRAP)}>{person.name}</TableCell>
              {showEmail ? (
                <TableCell className={cn("min-w-[12rem] text-warm-granite", WRAP)}>{person.email ?? "—"}</TableCell>
              ) : null}
              {showPhone ? (
                <TableCell className="whitespace-nowrap text-warm-granite" data-testid="telefone-mascarado">
                  {maskPhone(person.phone)}
                </TableCell>
              ) : null}
              {showUnit ? (
                <TableCell className={cn("min-w-[10rem] text-body-sm", WRAP)}>
                  {lookupUnitText(person.unit_id, units)}
                </TableCell>
              ) : null}
              {showIdentifier ? (
                <TableCell className={cn("text-warm-granite", WRAP)}>{person.institutional_identifier ?? "—"}</TableCell>
              ) : null}
              {showActive ? (
                <TableCell>
                  {person.active === undefined ? "—" : <ActiveBadge active={person.active} feminine={false} />}
                </TableCell>
              ) : null}
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}

// Unidades (`GET /units/accessible`: lista do escopo; busca/ordem locais) --------

export function UnitsReadTable({
  units,
  sort,
  onSortChange,
  pageKey,
  filtered,
}: {
  units: AccessibleUnit[];
  sort: UnitSort;
  onSortChange: (sort: UnitSort) => void;
  pageKey: string | number;
  filtered: boolean;
}) {
  return (
    <Table aria-label="Unidades">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="code" label="Sigla" sort={sort} onSortChange={onSortChange} />
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          <TableHead>Situação</TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {units.length === 0 ? (
          <TableEmpty
            colSpan={3}
            icon={Building2}
            title={filtered ? "Nenhuma unidade encontrada para os filtros atuais." : "Nenhuma unidade no seu escopo."}
            description={
              filtered ? "Ajuste a busca ou limpe os filtros." : "O acesso às unidades é concedido por um administrador."
            }
          />
        ) : (
          units.map((unit, index) => (
            <AnimatedTableRow key={unit.id} index={index}>
              <TableCell className="whitespace-nowrap text-eyebrow">{unit.code}</TableCell>
              <TableCell className={cn("min-w-[14rem]", WRAP)}>{unit.name}</TableCell>
              <TableCell>
                <ActiveBadge active={unit.active} feminine />
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}
