"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { StatusIndicator } from "@/components/ui/status-indicator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InviteUserDialog } from "@/components/features/users/invite-user-dialog";
import { UsersTable } from "@/components/features/users/users-table";
import { ApiError, listUsers, revokeUser, type UserListItem } from "@/lib/users-api";

// =============================================================================
// /administracao/usuarios — Lista de usuários + convite + revogação
// =============================================================================
// Lista: `GET /api/v1/users` (ADM + `users.manage`). Convite:
// `POST /api/v1/users/invite` (ADM + AAL2 + `users.invite`) — ver
// `components/features/users/invite-user-dialog.tsx`. Revogação:
// `POST /api/v1/users/{id}/revoke`.
//
// Paginação: a página anterior continua visível (esmaecida, aria-busy) até a
// próxima chegar (keepPreviousData), com indicador "Carregando página…".
// Sucesso de revogação só após a resposta do backend (toast + invalidação).
// =============================================================================

const PAGE_SIZE = 20;

export default function AdministracaoUsuariosPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [userToRevoke, setUserToRevoke] = useState<UserListItem | null>(null);

  const usersQuery = useQuery({
    queryKey: ["users", page],
    queryFn: () => listUsers({ page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeUser(id),
    onSuccess: () => {
      toast.success("Acesso revogado com sucesso.");
      setUserToRevoke(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      toast.error(revokeErrorMessage(error));
    },
  });

  const totalPages = usersQuery.data ? Math.max(1, Math.ceil(usersQuery.data.total / PAGE_SIZE)) : 1;
  const busy = usersQuery.isFetching && !usersQuery.isPending;
  const changingPage = usersQuery.isPlaceholderData;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-eyebrow text-pale-stone">Administração</span>
          <h1 className="text-heading text-bone">Usuários</h1>
          <p className="max-w-page text-body-sm text-warm-granite">
            Gerencie convites e acessos de usuários do sistema.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>Convidar Usuário</Button>
      </div>

      {usersQuery.isPending && (
        <LoadingSkeleton variant="table" count={5} columns={5} label="Carregando usuários…" />
      )}

      {usersQuery.isError && (
        <SlideIn distance="sm">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>{listErrorMessage(usersQuery.error)}</FormMessage>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={usersQuery.isFetching}
              onClick={() => usersQuery.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      )}

      {usersQuery.data && (
        <>
          <UsersTable
            users={usersQuery.data.users}
            pageKey={usersQuery.data.page}
            busy={busy}
            revokingId={revokeMutation.isPending ? (revokeMutation.variables ?? null) : null}
            onRevoke={setUserToRevoke}
          />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-body-sm text-warm-granite" aria-live="polite">
                Página {usersQuery.data.page} de {totalPages} · {usersQuery.data.total} usuário(s)
              </span>
              {changingPage ? <StatusIndicator state="loading" label="Carregando página…" /> : null}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || changingPage}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || changingPage}
                onClick={() => setPage((p) => p + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog
        open={!!userToRevoke}
        onOpenChange={(open) => !open && !revokeMutation.isPending && setUserToRevoke(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revogar acesso</DialogTitle>
            <DialogDescription>
              Tem certeza de que deseja revogar o acesso de {userToRevoke?.name} (
              {userToRevoke?.email})? Esta ação pode ser desfeita apenas com um novo convite.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outlineOnLight"
              onClick={() => setUserToRevoke(null)}
              disabled={revokeMutation.isPending}
            >
              Cancelar
            </Button>
            {/* Ação confirmatória sobre cartão claro: botão escuro (DESIGN.md >
                CTA Section Card). `destructive` (laranja) teria 2.9:1 sobre bone. */}
            <Button
              loading={revokeMutation.isPending}
              onClick={() => userToRevoke && revokeMutation.mutate(userToRevoke.id)}
            >
              {revokeMutation.isPending ? "Revogando…" : "Revogar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
    if (error.status === 403) {
      return "Você não tem permissão para visualizar usuários. É necessário o papel ADM com a permissão de gestão de usuários.";
    }
  }
  return "Não foi possível carregar a lista de usuários. Tente novamente.";
}

function revokeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
    if (error.status === 403) return "Você não tem permissão para revogar acessos.";
    if (error.status === 409) {
      return "Não é possível revogar: este é o último administrador (ADM) do sistema.";
    }
  }
  return "Não foi possível revogar o acesso agora. Tente novamente.";
}
