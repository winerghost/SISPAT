"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Check, CircleSlash, Trash2, Users } from "lucide-react";

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
import type { UserSort, UserSummary } from "@/lib/users-api";
import { UserAvatar } from "./user-avatar";
import { unitLabel } from "./unit-checkbox-list";
import { formatDateTime, isDeletedUser, userDisplayEmail, userDisplayName } from "./user-labels";

// =============================================================================
// UsersTable — lista paginada de `GET /api/v1/users`.
// Ordenação só pelas colunas da allowlist do backend (nome, e-mail, último
// acesso), com `aria-sort` no cabeçalho e botão nativo. A tabela rola na
// horizontal DENTRO do próprio contêiner (Table) — nunca a página.
// Motion: entrada escalonada das linhas quando a página/filtro muda
// (`pageKey`), `busy` esmaece enquanto a próxima resposta chega.
// Status com ícone + texto (nunca só cor). Datas em America/Araguaina.
// Usuário excluído não vem nesta lista (o backend filtra `deleted_at IS NULL`);
// se vier, a linha mostra o rótulo anonimizado e NUNCA o identificador —
// `userDisplayName`/`userDisplayEmail` decidem pelo payload, não pela string.
// =============================================================================

type SortField = "name" | "email" | "last_login_at";

interface UsersTableProps {
  users: UserSummary[];
  pageKey: string | number;
  busy?: boolean;
  sort: UserSort;
  onSortChange: (sort: UserSort) => void;
  onManage: (user: UserSummary) => void;
  filtered?: boolean;
}

export function UsersTable({ users, pageKey, busy = false, sort, onSortChange, onManage, filtered = false }: UsersTableProps) {
  return (
    <Table busy={busy} aria-label="Usuários">
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <SortableHead field="name" label="Nome" sort={sort} onSortChange={onSortChange} />
          <SortableHead field="email" label="E-mail" sort={sort} onSortChange={onSortChange} />
          <TableHead>Perfil</TableHead>
          <TableHead>Unidades</TableHead>
          <TableHead>Status</TableHead>
          <SortableHead field="last_login_at" label="Último acesso" sort={sort} onSortChange={onSortChange} />
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {users.length === 0 ? (
          <TableEmpty
            colSpan={7}
            icon={Users}
            title={filtered ? "Nenhum usuário encontrado para os filtros atuais." : "Nenhum usuário encontrado."}
            description={
              filtered ? "Ajuste a busca ou limpe os filtros." : "Use “Convidar Usuário” para enviar o primeiro convite."
            }
          />
        ) : (
          users.map((user, index) => {
            const lastLogin = formatDateTime(user.last_login_at);
            const deleted = isDeletedUser(user);
            const displayName = userDisplayName(user);
            const displayEmail = userDisplayEmail(user);
            return (
              <AnimatedTableRow key={user.id} index={index}>
                <TableCell className="min-w-[14rem]">
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      userId={user.id}
                      name={displayName}
                      hasAvatar={!deleted && user.has_avatar}
                      size="sm"
                      lazy
                    />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{displayName}</span>
                  </div>
                </TableCell>
                <TableCell className="min-w-[12rem] break-words text-warm-granite [overflow-wrap:anywhere]">
                  {displayEmail ?? "—"}
                </TableCell>
                <TableCell>
                  {user.role ? (
                    <Badge variant="outline">{user.role}</Badge>
                  ) : (
                    <Badge variant="default">Sem perfil</Badge>
                  )}
                </TableCell>
                <TableCell className="min-w-[10rem]">
                  {user.units.length === 0 ? (
                    <span className="text-warm-granite">Nenhuma</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {user.units.map((unit) => (
                        <li key={unit.id} className="break-words text-body-sm [overflow-wrap:anywhere]">
                          {unitLabel(unit)}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell>
                  {deleted ? (
                    <Badge variant="warning">
                      <Trash2 aria-hidden="true" />
                      Excluído
                    </Badge>
                  ) : (
                    <Badge variant={user.active ? "success" : "default"}>
                      {user.active ? <Check aria-hidden="true" /> : <CircleSlash aria-hidden="true" />}
                      {user.active ? "Ativo" : "Inativo"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-warm-granite">{lastLogin ?? "Nunca"}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deleted}
                    onClick={() => onManage(user)}
                    aria-label={`Gerenciar ${displayName}`}
                  >
                    Gerenciar
                  </Button>
                </TableCell>
              </AnimatedTableRow>
            );
          })
        )}
      </AnimatedTableBody>
    </Table>
  );
}

function SortableHead({
  field,
  label,
  sort,
  onSortChange,
}: {
  field: SortField;
  label: string;
  sort: UserSort;
  onSortChange: (sort: UserSort) => void;
}) {
  const ascending = sort === field;
  const descending = sort === `-${field}`;
  const Icon = ascending ? ArrowUp : descending ? ArrowDown : ArrowUpDown;
  const next = (ascending ? `-${field}` : field) as UserSort;
  return (
    <TableHead aria-sort={ascending ? "ascending" : descending ? "descending" : "none"}>
      <button
        type="button"
        onClick={() => onSortChange(next)}
        className={cn(
          // `relative`: contém o texto sr-only (absolute) dentro do contêiner
          // com rolagem da tabela — sem ele, o span escaparia para o documento
          // e criaria rolagem horizontal da PÁGINA no celular.
          "relative -mx-1 inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-buttons px-1 uppercase transition-factory hover:text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone",
          (ascending || descending) && "text-bone",
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">
          {ascending ? "(crescente; ativar para decrescente)" : descending ? "(decrescente; ativar para crescente)" : "(ativar para ordenar)"}
        </span>
      </button>
    </TableHead>
  );
}
