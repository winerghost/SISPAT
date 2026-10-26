"use client";

import { useEffect, useRef } from "react";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { ASSET_VERSION_CONFLICT_MESSAGE } from "./asset-labels";

// =============================================================================
// Aviso ÚNICO de conflito de versão (409 version_conflict) dentro do formulário
// de edição. O rascunho do usuário NÃO é perdido: o aviso lista, por campo
// divergente, o que está "no servidor" e oferece duas saídas explícitas:
//   - manter as minhas alterações e salvar de novo (com a version recarregada);
//   - descartar o rascunho e usar os dados do servidor.
// Recebe o foco ao aparecer (role="alert" anuncia; o foco leva o teclado até ele).
// Texto sempre da tabela fixa de asset-labels (nunca error.message do backend).
// =============================================================================

export interface ConflictDifference {
  key: string;
  label: string;
  mine: string;
  server: string;
}

export interface AssetConflictNoticeProps {
  differences: readonly ConflictDifference[];
  /** `false` quando nenhum campo do rascunho difere do servidor (nada a reenviar). */
  canKeep: boolean;
  pending: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}

export function AssetConflictNotice({ differences, canKeep, pending, onKeep, onDiscard }: AssetConflictNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <SlideIn distance="sm">
      <div
        ref={ref}
        tabIndex={-1}
        role="alert"
        className="flex flex-col gap-3 rounded-cards border border-obsidian-canvas p-4 text-body-sm text-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas"
      >
        <p className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-signal-orange" />
          <span className="font-medium">Este bem foi alterado por outra pessoa</span>
        </p>
        <p>{ASSET_VERSION_CONFLICT_MESSAGE} Suas alterações foram mantidas neste formulário.</p>
        {differences.length > 0 ? (
          <ul aria-label="Campos que diferem do servidor" className="flex flex-col gap-2">
            {differences.map((item) => (
              <li key={item.key} className="break-words [overflow-wrap:anywhere]">
                <span className="font-medium">{item.label}</span>
                <br />
                <span>sua alteração: {item.mine}</span>
                <br />
                <span>no servidor: {item.server}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          {canKeep ? (
            <Button type="button" size="lg" className="h-auto min-h-11 whitespace-normal py-2 text-left" disabled={pending} onClick={onKeep}>
              Manter minhas alterações e salvar de novo
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outlineOnLight"
            size="lg"
            className="h-auto min-h-11 whitespace-normal py-2 text-left"
            disabled={pending}
            onClick={onDiscard}
          >
            Descartar e usar dados do servidor
          </Button>
        </div>
      </div>
    </SlideIn>
  );
}
