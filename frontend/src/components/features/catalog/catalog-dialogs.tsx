"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

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
import { FormField, RequiredLegend, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { ConfirmActionDialog } from "@/components/features/users/confirm-action-dialog";
import { blankToNull, type CatalogNoun } from "./catalog-labels";

// =============================================================================
// Diálogos compartilhados dos cadastros de apoio.
// - CatalogFormDialog: casca de formulário (criar/editar) sobre o Dialog claro.
//   Não fecha enquanto a requisição está em curso; o sucesso só é exibido
//   (toast + fechar) pelo chamador depois da resposta do backend.
// - ActiveToggleDialog: "Inativar"/"Reativar" com confirmação. Deixa explícito
//   que o registro é PRESERVADO (não existe exclusão) e o que muda de fato.
// Validação no cliente é só UX; o backend valida e decide permissão.
// =============================================================================

export function CatalogFormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pendingLabel = "Salvando…",
  pending,
  error,
  submitDisabled = false,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  pending: boolean;
  error: string | null;
  submitDisabled?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={pending || undefined}>
          <RequiredLegend surface="light" />
          {children}
          {error ? (
            <SlideIn distance="sm">
              <FormMessage surface="light">{error}</FormMessage>
            </SlideIn>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outlineOnLight" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" loading={pending} disabled={submitDisabled}>
              {pending ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DEACTIVATE_CONSEQUENCES: Record<CatalogNoun, string[]> = {
  sala: [
    "A sala NÃO é excluída: o registro, o histórico e a auditoria são preservados.",
    "Bens já vinculados a esta sala continuam vinculados e legíveis; a inativação só impede NOVAS associações.",
    "Você pode reativar a sala quando quiser.",
  ],
  "pessoa responsável": [
    "A pessoa NÃO é excluída: o registro, o histórico e a auditoria são preservados.",
    "Bens já sob a responsabilidade desta pessoa continuam vinculados e legíveis; a inativação só impede NOVAS associações.",
    "Você pode reativar a pessoa quando quiser.",
  ],
  unidade: [
    "A unidade NÃO é excluída: o registro, o histórico e a auditoria são preservados.",
    "Ela deixa de aparecer nas listas de seleção e não aceita novas salas nem pessoas responsáveis.",
    "Registros já existentes na unidade continuam válidos e legíveis.",
    "Você pode reativar a unidade quando quiser.",
  ],
};

const ACTIVATE_CONSEQUENCES: Record<CatalogNoun, string[]> = {
  sala: ["A sala volta a poder receber novas associações."],
  "pessoa responsável": ["A pessoa volta a poder receber novas associações."],
  unidade: ["A unidade volta a aparecer nas listas e a aceitar novas salas e pessoas responsáveis."],
};

export function ActiveToggleDialog({
  open,
  onOpenChange,
  noun,
  name,
  activate,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noun: CatalogNoun;
  name: string;
  /** `true` = reativar; `false` = inativar. */
  activate: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string | undefined) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);
  const verb = activate ? "Reativar" : "Inativar";
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${verb} ${noun}`}
      description={`Registro selecionado: ${name}`}
      consequences={activate ? ACTIVATE_CONSEQUENCES[noun] : DEACTIVATE_CONSEQUENCES[noun]}
      confirmLabel={verb}
      pendingLabel={activate ? "Reativando…" : "Inativando…"}
      pending={pending}
      error={error}
      onConfirm={() => onConfirm(blankToNull(reason) ?? undefined)}
    >
      <FormField id="catalogo-motivo" label="Motivo (opcional)" surface="light" hint="Até 500 caracteres. Fica na auditoria.">
        {(field) => (
          <textarea
            {...field}
            name="reason"
            maxLength={500}
            className={textareaControlClassName}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
          />
        )}
      </FormField>
    </ConfirmActionDialog>
  );
}
