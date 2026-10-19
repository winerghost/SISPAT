"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import type { ActiveActionRequest } from "@/lib/catalog-api";
import { ActiveToggleDialog } from "./catalog-dialogs";
import { catalogErrorMessage, isCatalogVersionConflict, VERSION_CONFLICT_MESSAGE, type CatalogNoun } from "./catalog-labels";

// =============================================================================
// Inativar/reativar um registro de cadastro de apoio (POST .../deactivate|activate).
// Envia `expected_updated_at` (pré-condição de concorrência). Sucesso só depois
// da resposta do backend (toast + fechar + recarregar); 409 `version_conflict`
// fecha o diálogo, avisa e recarrega a lista; demais erros ficam no diálogo.
// =============================================================================

interface Toggleable {
  id: string;
  name: string;
  active: boolean;
  updated_at: string | null;
}

export function useActiveToggle<T extends Toggleable>({
  noun,
  request,
  onDone,
}: {
  noun: CatalogNoun;
  request: (id: string, active: boolean, payload: ActiveActionRequest) => Promise<T>;
  /** Chamado após sucesso OU conflito: recarregar listas/detalhes. */
  onDone: (saved: T | null) => void;
}) {
  const [target, setTarget] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ row, reason }: { row: T; reason: string | undefined }) =>
      request(row.id, !row.active, {
        reason,
        expected_updated_at: row.updated_at ?? undefined,
      }),
    onSuccess: (saved, { row }) => {
      toast.success(row.active ? "Registro inativado. Ele foi preservado." : "Registro reativado.");
      setOpen(false);
      onDone(saved);
    },
    onError: (err) => {
      if (isCatalogVersionConflict(err)) {
        setOpen(false);
        toast.error(VERSION_CONFLICT_MESSAGE);
        onDone(null);
        return;
      }
      setError(catalogErrorMessage(err, noun, "Não foi possível concluir a ação agora. Tente novamente."));
    },
  });

  function ask(row: T) {
    setTarget(row);
    setError(null);
    mutation.reset();
    setOpen(true);
  }

  const dialog = (
    <ActiveToggleDialog
      open={open}
      onOpenChange={setOpen}
      noun={noun}
      name={target?.name ?? ""}
      activate={target ? !target.active : false}
      pending={mutation.isPending}
      error={error}
      onConfirm={(reason) => target && mutation.mutate({ row: target, reason })}
    />
  );

  return { ask, dialog };
}
