"use client";

import type { FormEvent, ReactNode } from "react";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";

// =============================================================================
// Diálogo de confirmação das ações de conta/perfil. Diz exatamente o que vai
// acontecer (lista `consequences`) antes de chamar o backend. Enquanto a
// requisição está em curso não fecha (Esc/overlay ignorados) e o botão mostra
// `loading`; o sucesso só é exibido após a resposta. Superfície clara do
// Dialog: ação confirmatória com botão escuro (destructive laranja teria
// 2.9:1 sobre bone — ver page de usuários).
// =============================================================================

export interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  consequences?: ReactNode[];
  confirmLabel: string;
  /** Rótulo do botão que recusa (padrão "Cancelar"). */
  cancelLabel?: string;
  /** Para devolver o foco a um elemento específico ao fechar (ex.: diálogo aninhado). */
  onCloseAutoFocus?: (event: Event) => void;
  pendingLabel?: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
  /** Campos extras (ex.: motivo opcional, código do autenticador). */
  children?: ReactNode;
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmLabel,
  cancelLabel = "Cancelar",
  onCloseAutoFocus,
  pendingLabel,
  pending = false,
  confirmDisabled = false,
  error,
  onConfirm,
  children,
}: ConfirmActionDialogProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending && !confirmDisabled) onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate aria-busy={pending || undefined}>
          {consequences && consequences.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-obsidian-canvas">
              {consequences.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : null}

          {children}

          {error ? (
            <SlideIn distance="sm">
              <FormMessage surface="light">{error}</FormMessage>
            </SlideIn>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outlineOnLight" onClick={() => onOpenChange(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type="submit" loading={pending} disabled={confirmDisabled}>
              {pending && pendingLabel ? pendingLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
