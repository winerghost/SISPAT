"use client";

import { useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { catalogErrorMessage, isCatalogNotFound, type CatalogNoun } from "./catalog-labels";

// =============================================================================
// Registro aberto para edição: o detalhe (`GET .../<id>`) traz o `updated_at`
// mais recente (pré-condição `expected_updated_at`); a linha da lista serve de
// esboço até a resposta chegar. 404 => "não encontrado ou fora do escopo" (o
// backend não diferencia, de propósito). Conflito 409 => recarrega o detalhe.
// =============================================================================

export function useCatalogRecord<T extends { updated_at: string | null }>({
  open,
  row,
  queryKey,
  fetchRecord,
  noun,
}: {
  open: boolean;
  /** Linha selecionada; `null` = modo criação (nada a buscar). */
  row: T | null;
  queryKey: QueryKey;
  fetchRecord: () => Promise<T>;
  noun: CatalogNoun;
}) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const detail = useQuery({
    queryKey,
    queryFn: fetchRecord,
    enabled: open && !!row,
    // Registros são objetos simples (nunca funções): o cast só satisfaz o tipo condicional do React Query.
    placeholderData: (row ?? undefined) as unknown as undefined,
    retry: false,
  });
  const notFound = detail.isError && isCatalogNotFound(detail.error);
  return {
    record: row ? (detail.data ?? row) : null,
    notFound,
    /** `true` enquanto só o esboço da linha está disponível (detalhe ainda carregando). */
    placeholder: detail.isPlaceholderData,
    loadError:
      detail.isError && !notFound
        ? catalogErrorMessage(detail.error, noun, "Não foi possível atualizar os dados deste registro.")
        : null,
    conflict,
    onConflict() {
      setConflict(true);
      void queryClient.invalidateQueries({ queryKey });
    },
  };
}
