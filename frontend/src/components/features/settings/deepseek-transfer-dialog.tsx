"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// =============================================================================
// Aviso de transferência internacional de dados (LGPD) exigido antes de usar
// o DeepSeek. O checkbox é obrigatório para confirmar; o aceite em si só é
// gravado (com data e ADM, auditado) pelo backend quando o formulário é salvo
// com `acknowledge_international_transfer: true`.
// Superfície clara do Dialog: textos obsidian/graphite-mid (contraste AA).
// =============================================================================

export interface DeepseekTransferDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeepseekTransferDialog({ open, onConfirm, onCancel }: DeepseekTransferDialogProps) {
  const [accepted, setAccepted] = useState(false);
  const checkboxId = `aceite-${useId().replace(/:/g, "")}`;

  // Cada abertura começa com o checkbox desmarcado (aceite sempre explícito).
  useEffect(() => {
    if (open) setAccepted(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transferência internacional de dados</DialogTitle>
          <DialogDescription>
            O DeepSeek processa as solicitações em servidores fora do Brasil. Pela LGPD, isso é uma
            transferência internacional de dados e precisa da sua confirmação expressa.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex list-disc flex-col gap-2 pl-5 text-body-sm text-obsidian-canvas">
          <li>
            Somente dados agregados e anonimizados são enviados — nunca nomes, e-mails, CPF, matrículas
            ou identificadores de pessoas.
          </li>
          <li>O aceite é registrado com a data e o seu usuário, e fica na auditoria.</li>
          <li>O aceite só é gravado quando você salvar as configurações.</li>
        </ul>

        <div className="flex items-start gap-3">
          <label
            htmlFor={checkboxId}
            className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm"
          >
            <input
              id={checkboxId}
              type="checkbox"
              required
              aria-required="true"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              className="h-4 w-4 cursor-pointer rounded-sm accent-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-bone"
            />
          </label>
          <label htmlFor={checkboxId} className="cursor-pointer pt-0.5 text-body-sm text-obsidian-canvas">
            Li e entendi o aviso e autorizo o uso do DeepSeek com envio de dados agregados e
            anonimizados para fora do Brasil.
          </label>
        </div>

        <DialogFooter>
          <Button variant="outlineOnLight" onClick={onCancel}>
            Cancelar
          </Button>
          {/* Sobre cartão claro: botão escuro (DESIGN.md > CTA Section Card). */}
          <Button onClick={onConfirm} disabled={!accepted}>
            Confirmar e usar DeepSeek
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
