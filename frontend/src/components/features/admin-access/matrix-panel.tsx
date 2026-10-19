"use client";

import { Check, Minus } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccessPermissionRow, AccessRole } from "@/lib/admin-access-api";

// =============================================================================
// Aba "Matriz": linhas = permissões, colunas = perfis (da API). A marca é
// ícone + texto acessível (nunca só cor). A tabela rola DENTRO do próprio
// contêiner (região focável) em telas estreitas, nunca a página.
// =============================================================================

export function MatrixPanel({ roles, permissions }: { roles: AccessRole[]; permissions: AccessPermissionRow[] }) {
  if (permissions.length === 0 || roles.length === 0) {
    return (
      <EmptyState
        title="Nenhuma permissão encontrada"
        description="O servidor não devolveu permissões para montar a matriz."
      />
    );
  }
  const rows = [...permissions].sort((a, b) => a.code.localeCompare(b.code, "pt-BR"));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="max-w-page text-body-sm text-warm-granite">
        Cada linha é uma permissão; cada coluna, um perfil. Somente consulta: perfis e permissões não são alterados
        aqui.
      </p>
      <div className="min-w-0 rounded-cards border border-ash-stroke">
        <Table
          regionLabel="Matriz de permissões por perfil"
          aria-label="Matriz de permissões por perfil"
          className="min-w-[34rem]"
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col">Permissão</TableHead>
              {roles.map((role) => (
                <TableHead key={role.code} scope="col" className="text-center">
                  <span className="font-mono">{role.code}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((perm) => (
              <TableRow key={perm.code}>
                <TableCell className="min-w-0 break-words">
                  <span className="font-mono text-body-sm text-bone">{perm.code}</span>
                  {perm.description ? (
                    <span className="block text-body-sm text-warm-granite">{perm.description}</span>
                  ) : null}
                </TableCell>
                {roles.map((role) => {
                  const granted = perm.roles.includes(role.code);
                  return (
                    <TableCell key={role.code} className="text-center" data-granted={granted}>
                      {granted ? (
                        <Check className="mx-auto h-4 w-4 text-metric-green" aria-hidden="true" />
                      ) : (
                        <Minus className="mx-auto h-4 w-4 text-warm-granite" aria-hidden="true" />
                      )}
                      <span className="sr-only">{granted ? "Concedida" : "Não concedida"}</span>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
