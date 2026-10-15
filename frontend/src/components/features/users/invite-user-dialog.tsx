"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

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
import {
  FormField,
  RequiredLegend,
  selectControlClassName,
  textareaControlClassName,
} from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ApiError, inviteUser, type IntendedRoleCode } from "@/lib/users-api";
import { rateLimitMessage } from "@/lib/api-errors";
import { UnitCheckboxList } from "./unit-checkbox-list";

// =============================================================================
// InviteUserDialog — convite de usuário (POST /api/v1/users/invite).
// =============================================================================
// Unidades: checkboxes com as unidades do escopo do ADM (`GET /api/v1/units`,
// ver `unit-checkbox-list.tsx`) — sem UUID digitado à mão.
//
// Validação no cliente é só UX (o backend valida de fato e decide permissão:
// ADM + AAL2 + `users.invite`). `noValidate`: as mensagens nativas do
// navegador dão lugar a erros por campo (FormField: role="alert",
// aria-invalid, aria-describedby, entrada fade + 4px); `required`/`type=email`
// continuam no DOM (validity intacta). Foco vai ao primeiro campo inválido.
// Sucesso (toast + fechar) só no onSuccess — nunca antes da resposta.
// =============================================================================

type FieldErrors = Partial<Record<"name" | "email" | "units", string>>;

const FIELD_IDS = {
  name: "convite-nome",
  email: "convite-email",
  units: "convite-unidades",
} as const;

export function InviteUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<IntendedRoleCode>("USER");
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [justification, setJustification] = useState("");
  const [showJustification, setShowJustification] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: inviteUser,
    onSuccess: (data) => {
      toast.success(`Convite enviado para ${data.email}.`);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      resetAndClose();
    },
    onError: (error) => {
      setFormError(inviteErrorMessage(error));
    },
  });

  const pending = inviteMutation.isPending;

  function resetAndClose() {
    setName("");
    setEmail("");
    setRole("USER");
    setUnitIds([]);
    setJustification("");
    setShowJustification(false);
    setErrors({});
    setFormError(null);
    onOpenChange(false);
  }

  function clearError(field: keyof FieldErrors) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const form = event.currentTarget;
    const emailInput = form.elements.namedItem("email") as HTMLInputElement | null;
    const unit_ids = unitIds;

    const next: FieldErrors = {};
    if (!name.trim()) next.name = "Informe o nome.";
    if (!email.trim()) next.email = "Informe o e-mail institucional.";
    else if (emailInput?.validity.typeMismatch) next.email = "Informe um e-mail válido.";
    if (unit_ids.length === 0) next.units = "Selecione ao menos uma unidade.";

    setErrors(next);
    const firstInvalid = (["name", "email", "units"] as const).find((field) => next[field]);
    if (firstInvalid) {
      const target = document.getElementById(FIELD_IDS[firstInvalid]);
      (firstInvalid === "units" ? target?.querySelector<HTMLInputElement>("input") : target)?.focus();
      return;
    }

    inviteMutation.mutate({
      name: name.trim(),
      email: email.trim(),
      intended_role_code: role,
      unit_ids,
      justification: justification.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : !pending && resetAndClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar Usuário</DialogTitle>
          <DialogDescription>
            Um e-mail de convite será enviado pelo Supabase Auth para que a pessoa defina sua
            senha e ative a conta.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate aria-busy={pending || undefined}>
          <RequiredLegend surface="light" />

          <FormField id={FIELD_IDS.name} label="Nome" required error={errors.name} surface="light">
            {(field) => (
              <Input
                {...field}
                name="name"
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
                disabled={pending}
              />
            )}
          </FormField>

          <FormField
            id={FIELD_IDS.email}
            label="E-mail institucional"
            required
            error={errors.email}
            surface="light"
          >
            {(field) => (
              <Input
                {...field}
                name="email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError("email");
                }}
                disabled={pending}
              />
            )}
          </FormField>

          <FormField id="convite-perfil" label="Perfil" required surface="light">
            {(field) => (
              <select
                {...field}
                name="role"
                className={selectControlClassName}
                value={role}
                onChange={(e) => setRole(e.target.value as IntendedRoleCode)}
                disabled={pending}
              >
                <option value="USER">USER</option>
                <option value="RH">RH</option>
              </select>
            )}
          </FormField>

          <UnitCheckboxList
            id={FIELD_IDS.units}
            legend="Unidades"
            required
            surface="light"
            selected={unitIds}
            error={errors.units}
            disabled={pending}
            onChange={(next) => {
              setUnitIds(next);
              clearError("units");
            }}
          />

          {/* Seção expansível: campo opcional fora do caminho principal. */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={showJustification}
              aria-controls="convite-justificativa-secao"
              onClick={() => setShowJustification((value) => !value)}
              disabled={pending}
              className="inline-flex min-h-8 items-center gap-1.5 self-start rounded-sm text-eyebrow text-graphite-mid transition-factory hover:text-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas disabled:opacity-50"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-fast ease-factory",
                  showJustification && "rotate-180",
                )}
              />
              Justificativa (opcional)
            </button>
            <div id="convite-justificativa-secao" hidden={!showJustification}>
              {showJustification ? (
                <SlideIn distance="sm">
                  <FormField id="convite-justificativa" label="Justificativa" surface="light">
                    {(field) => (
                      <textarea
                        {...field}
                        name="justification"
                        className={textareaControlClassName}
                        value={justification}
                        onChange={(e) => setJustification(e.target.value)}
                        disabled={pending}
                      />
                    )}
                  </FormField>
                </SlideIn>
              ) : null}
            </div>
          </div>

          {formError && (
            <SlideIn distance="sm">
              <FormMessage id="convite-erro" surface="light">
                {formError}
              </FormMessage>
            </SlideIn>
          )}

          <DialogFooter>
            <Button type="button" variant="outlineOnLight" onClick={resetAndClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" loading={pending}>
              Enviar convite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function inviteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
    if (error.status === 403) {
      return "Você não tem permissão para convidar usuários, ou sua sessão ainda não confirmou a verificação em duas etapas (AAL2).";
    }
    if (error.status === 429) return rateLimitMessage(error);
    if (error.status === 409) {
      return "Já existe um convite pendente para este e-mail.";
    }
  }
  return "Não foi possível enviar o convite agora. Tente novamente.";
}
