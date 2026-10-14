"use client";

import { Check, CircleSlash, Users } from "lucide-react";

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
import type { UserListItem } from "@/lib/users-api";

// =============================================================================
// UsersTable — lista paginada de usuários (dados de GET /api/v1/users).
// Motion: linhas com hover/foco discreto (150 ms), entrada escalonada só das
// linhas da página (máx. 20) quando `pageKey` muda; `busy` esmaece a tabela
// enquanto a próxima página carrega. Sem ordenação: o endpoint só aceita
// page/page_size. Status com ícone + texto (não só cor).
// =============================================================================

interface UsersTableProps {
  users: UserListItem[];
  /** Muda quando a página exibida muda → reanima o corpo da tabela. */
  pageKey: string | number;
  busy?: boolean;
  revokingId?: string | null;
  onRevoke: (user: UserListItem) => void;
}

export function UsersTable({ users, pageKey, busy = false, revokingId, onRevoke }: UsersTableProps) {
  return (
    <Table busy={busy}>
      <TableHeader>
        <TableRow className="hover:bg-transparent focus-within:bg-transparent">
          <TableHead>Nome</TableHead>
          <TableHead>E-mail</TableHead>
          <TableHead>Papéis</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Ações</TableHead>
        </TableRow>
      </TableHeader>
      <AnimatedTableBody key={pageKey}>
        {users.length === 0 ? (
          <TableEmpty
            colSpan={5}
            icon={Users}
            title="Nenhum usuário encontrado."
            description="Use “Convidar Usuário” para enviar o primeiro convite."
          />
        ) : (
          users.map((user, index) => (
            <AnimatedTableRow key={user.id} index={index}>
              <TableCell>{user.name}</TableCell>
              <TableCell className="text-warm-granite">{user.email}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <Badge key={role} variant="outline">
                      {role}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={user.active ? "success" : "default"}>
                  {user.active ? <Check aria-hidden="true" /> : <CircleSlash aria-hidden="true" />}
                  {user.active ? "Ativo" : "Inativo"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="destructive"
                  size="sm"
                  loading={revokingId === user.id}
                  onClick={() => onRevoke(user)}
                >
                  Revogar Acesso
                </Button>
              </TableCell>
            </AnimatedTableRow>
          ))
        )}
      </AnimatedTableBody>
    </Table>
  );
}
