"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";
import { updateUser, USER_ROLES, type UpdateUserRequest, type UserRole, type UserSummary } from "@/lib/users-api";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { UnitCheckboxList, unitLabel, useUnits } from "./unit-checkbox-list";
import {
  isConfirmationRequired,
  isVersionConflict,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  userErrorMessage,
} from "./user-labels";

// =============================================================================
// Perfil e unidades — `PATCH /api/v1/users/<id>` com `version`.
// - Perfil: radio nativo (ADM/USER/RH). Promover a ADM ou rebaixar um ADM
//   abre uma confirmação explícita e só então envia
//   `confirm_privilege_change: true` (o backend exige; 400
//   `confirmation_required` reabre a confirmação).
// - Unidades: checkboxes das unidades do escopo do ADM (`GET /units`). Vínculos
//   com unidades fora do escopo só são listados (não editáveis aqui).
// - Só os campos alterados vão no corpo. 409 `version_conflict` → o pai
//   recarrega e avisa (este formulário é remontado com `key={version}`).
// Nada aqui é segurança: perfil/escopo/último ADM são decididos no backend.
// =============================================================================

export interface UserAccessFormProps {
  user: UserSummary;
  isSelf: boolean;
  onUpdated: (user: UserSummary) => void;
  onConflict: () => void;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function UserAccessForm({ user, isSelf, onUpdated, onConflict }: UserAccessFormProps) {
  const units = useUnits();
  const scopeIds = useMemo(() => new Set(units.data?.units.map((u) => u.id) ?? []), [units.data]);
  const initialUnitIds = useMemo(
    () => user.units.filter((u) => scopeIds.has(u.id)).map((u) => u.id),
    [user.units, scopeIds],
  );
  const outOfScope = units.data ? user.units.filter((u) => !scopeIds.has(u.id)) : [];

  const [role, setRole] = useState<UserRole | null>(user.role);
  const [unitIds, setUnitIds] = useState<string[] | null>(null);
  const [unitsError, setUnitsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const selectedUnits = unitIds ?? initialUnitIds;
  const roleChanged = role !== null && role !== user.role;
  const unitsChanged = unitIds !== null && !sameSet(unitIds, initialUnitIds);
  const dirty = roleChanged || unitsChanged;
  const privilegeChange = roleChanged && (role === "ADM" || user.role === "ADM");
  const promoting = role === "ADM";

  const mutation = useMutation({
    mutationFn: (confirm: boolean) => {
      const body: UpdateUserRequest = { version: user.version };
      if (roleChanged && role) body.role = role;
      if (unitsChanged) body.unit_ids = selectedUnits;
      if (confirm) body.confirm_privilege_change = true;
      return updateUser(user.id, body);
    },
    onSuccess: (saved) => {
      setConfirmOpen(false);
      toast.success("Perfil e unidades atualizados.");
      onUpdated(saved);
    },
    onError: (error) => {
      if (isVersionConflict(error)) {
        setConfirmOpen(false);
        onConflict();
        return;
      }
      if (isConfirmationRequired(error)) {
        setFormError(null);
        setConfirmOpen(true);
        return;
      }
      setConfirmOpen(false);
      setFormError(userErrorMessage(error, "Não foi possível salvar as alterações agora. Tente novamente."));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || mutation.isPending) return;
    setFormError(null);
    if (unitsChanged && selectedUnits.length === 0) {
      setUnitsError("Selecione ao menos uma unidade.");
      document.querySelector<HTMLInputElement>("#perfil-unidades input")?.focus();
      return;
    }
    if (unitsChanged && selectedUnits.length > 50) {
      setUnitsError("Selecione no máximo 50 unidades.");
      return;
    }
    if (privilegeChange) {
      setConfirmOpen(true);
      return;
    }
    mutation.mutate(false);
  }

  const pending = mutation.isPending;
  const locked = isSelf || pending;

  return (
    <>
      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6" aria-busy={pending || undefined}>
        {isSelf ? (
          <p className="rounded-cards border border-ash-stroke px-4 py-3 text-body-sm text-pale-stone">
            Este é o seu usuário. O seu próprio perfil e as suas unidades só podem ser alterados por outro
            administrador.
          </p>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-eyebrow text-pale-stone">Perfil</legend>
          {user.role === null ? (
            <p className="text-body-sm text-warm-granite">
              Sem perfil no momento (acesso revogado). Escolha um perfil para conceder acesso.
            </p>
          ) : null}
          {USER_ROLES.map((option) => {
            const id = `perfil-${option}`;
            return (
              <label
                key={option}
                htmlFor={id}
                className={cn(
                  "flex min-h-9 cursor-pointer items-start gap-3 rounded-buttons border px-3 py-2 transition-factory",
                  role === option ? "border-bone" : "border-ash-stroke hover:border-graphite-mid",
                  locked && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="perfil"
                  value={option}
                  checked={role === option}
                  disabled={locked}
                  onChange={() => {
                    setRole(option);
                    setFormError(null);
                  }}
                  aria-describedby={`${id}-descricao`}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas disabled:cursor-not-allowed"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-body-sm text-bone">{ROLE_LABEL[option]}</span>
                  <span id={`${id}-descricao`} className="text-caption leading-[1.4] text-warm-granite">
                    {ROLE_DESCRIPTION[option]}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <UnitCheckboxList
          id="perfil-unidades"
          legend="Unidades vinculadas"
          required
          hint="Somente as unidades do seu escopo de administração aparecem aqui."
          selected={selectedUnits}
          disabled={locked}
          error={unitsError}
          onChange={(next) => {
            setUnitIds(next);
            setUnitsError(null);
            setFormError(null);
          }}
        />

        {outOfScope.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-eyebrow text-pale-stone">Outras unidades (fora do seu escopo)</span>
            <ul className="flex flex-col gap-0.5 text-body-sm text-warm-granite">
              {outOfScope.map((unit) => (
                <li key={unit.id} className="break-words [overflow-wrap:anywhere]">
                  {unitLabel(unit)}
                </li>
              ))}
            </ul>
            <p className="text-caption leading-[1.4] text-warm-granite">
              Vínculos com unidades fora do seu escopo não podem ser alterados por você.
            </p>
          </div>
        ) : null}

        {formError ? (
          <SlideIn distance="sm">
            <FormMessage>{formError}</FormMessage>
          </SlideIn>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending} disabled={!dirty || isSelf}>
            {pending ? "Salvando…" : "Salvar perfil e unidades"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || pending}
            onClick={() => {
              setRole(user.role);
              setUnitIds(null);
              setUnitsError(null);
              setFormError(null);
            }}
          >
            Descartar alterações
          </Button>
        </div>
      </form>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={promoting ? "Promover a administrador" : "Remover privilégio de administrador"}
        description={
          promoting
            ? `${user.name} passará a ter o perfil ADM.`
            : `${user.name} deixará de ser administrador e passará ao perfil ${role ?? ""}.`
        }
        consequences={
          promoting
            ? [
                "Poderá convidar, alterar, desativar e reativar usuários das unidades do escopo dela.",
                "Poderá alterar configurações do sistema e executar importações.",
                "Precisará usar a verificação em duas etapas (MFA) para acessar a área administrativa.",
                "A mudança fica registrada na auditoria com o seu usuário.",
              ]
            : [
                "Perderá imediatamente o acesso à área administrativa.",
                "Se for o último administrador ativo, o sistema recusará a mudança.",
                "A mudança fica registrada na auditoria com o seu usuário.",
              ]
        }
        confirmLabel={promoting ? "Confirmar promoção" : "Confirmar remoção do privilégio"}
        pendingLabel="Salvando…"
        pending={pending}
        onConfirm={() => mutation.mutate(true)}
      />
    </>
  );
}
