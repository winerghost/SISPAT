"use client";

import { useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";

// =============================================================================
// Barra de ações FIXA do formulário de bem (rodapé do Dialog, fora da área que
// rola): estado anunciado (role="status"/aria-live), erro de servidor sempre
// visível (recebe o foco; texto da tabela fixa de asset-labels), alvos de 44px,
// empilha em 320px e respeita a área segura (safe-area). Salvar sem alterações
// fica aria-disabled (continua focável) e aponta, por aria-describedby, para a
// explicação do motivo.
// =============================================================================

export interface AssetEditActionsProps {
  /** `true` = edição (mostra "Sem alterações"/"N alterações"); criação não mostra contagem. */
  editing: boolean;
  changedCount: number;
  pending: boolean;
  /** Bloqueia o envio (ex.: bem que saiu do escopo). */
  blocked: boolean;
  submitLabel: string;
  error: string | null;
  onCancel: () => void;
}

export function AssetEditActions({
  editing,
  changedCount,
  pending,
  blocked,
  submitLabel,
  error,
  onCancel,
}: AssetEditActionsProps) {
  const baseId = useId().replace(/:/g, "");
  const explainId = `${baseId}-sem-alteracoes`;
  const errorRef = useRef<HTMLDivElement>(null);
  const noChanges = editing && changedCount === 0;

  // Erro novo => foco nele (a barra é fixa, então ele já está visível).
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const status = pending
    ? "Salvando…"
    : editing
      ? changedCount === 0
        ? "Sem alterações"
        : `${changedCount} ${changedCount === 1 ? "alteração" : "alterações"}`
      : "";

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-graphite-mid/40 bg-bone px-card-padding pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          className="rounded-buttons focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas"
        >
          <FormMessage surface="light">{error}</FormMessage>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <p role="status" aria-live="polite" className="text-body-sm text-obsidian-canvas">
            {status}
          </p>
          {noChanges && !pending ? (
            <p id={explainId} className="text-caption text-graphite-mid">
              Salvar fica disponível depois que você alterar algum campo.
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          {/* Em telas estreitas: lado a lado (economiza altura); Salvar (primário) à direita. */}
          <Button
            type="button"
            variant="outlineOnLight"
            size="lg"
            className="shrink-0 px-4 sm:px-6"
            onClick={onCancel}
            disabled={pending}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            size="lg"
            className="min-w-0 flex-1 px-3 sm:flex-none sm:px-6"
            loading={pending}
            disabled={blocked}
            aria-disabled={noChanges || undefined}
            aria-describedby={noChanges && !pending ? explainId : undefined}
            onClick={(event) => {
              if (noChanges) event.preventDefault();
            }}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
