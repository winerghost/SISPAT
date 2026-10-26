"use client";

import { useId, type ReactNode } from "react";

import { SlideIn } from "@/components/animations";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";

// =============================================================================
// FormField — rótulo + controle + dica + erro, reutilizável pelos futuros
// formulários (patrimônio, unidade, sala, responsável, inventário,
// movimentação, permissões). Garante, em um só lugar:
// - <label htmlFor> ligado ao controle (nome acessível);
// - obrigatório: `*` visual (aria-hidden) + `aria-required` + `required`;
// - erro: `aria-invalid`, `aria-describedby` → dica + mensagem, FormMessage
//   (role="alert") com entrada fade + 4px (200 ms) e saída imediata;
// - foco: a transição de borda vem do Input (transition-factory).
// Validação no cliente é só UX — o backend Flask valida de fato.
//
// Uso (render prop recebe os atributos a espalhar no controle):
//   <FormField label="Nome" required error={errors.name}>
//     {(field) => <Input {...field} value={name} onChange={…} />}
//   </FormField>
// =============================================================================

export interface FormFieldControlProps {
  id: string;
  required?: boolean;
  "aria-required"?: true;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export interface FormFieldProps {
  label: ReactNode;
  children: (field: FormFieldControlProps) => ReactNode;
  /** id do controle (padrão: gerado). */
  id?: string;
  required?: boolean;
  /** Texto de apoio permanente (entra no aria-describedby). */
  hint?: ReactNode;
  /** Mensagem de erro (null/undefined = sem erro). */
  error?: string | null;
  /** Superfície onde o campo está (Dialog = "light"). */
  surface?: "dark" | "light";
  className?: string;
}

export function FormField({
  label,
  children,
  id,
  required = false,
  hint,
  error,
  surface = "dark",
  className,
}: FormFieldProps) {
  const autoId = useId();
  const controlId = id ?? `campo-${autoId.replace(/:/g, "")}`;
  const hintId = `${controlId}-dica`;
  const errorId = `${controlId}-erro`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={controlId}
        className={cn(
          "text-eyebrow transition-factory",
          surface === "light" ? "text-graphite-mid" : "text-pale-stone",
        )}
      >
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1">
            *
          </span>
        ) : null}
      </label>
      {children({
        id: controlId,
        required: required || undefined,
        "aria-required": required ? true : undefined,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy || undefined,
      })}
      {hint ? (
        <p
          id={hintId}
          className={cn(
            "text-caption",
            surface === "light" ? "text-graphite-mid" : "text-warm-granite",
          )}
        >
          {hint}
        </p>
      ) : null}
      {/* Só ENTRADA animada: ao corrigir, a mensagem sai na hora — um
          role="alert" "fantasma" em fade-out confundiria leitores de tela. */}
      {error ? (
        <SlideIn distance="sm">
          <FormMessage id={errorId} surface={surface}>
            {error}
          </FormMessage>
        </SlideIn>
      ) : null}
    </div>
  );
}

/**
 * Classes de <select>/<textarea> nativos alinhadas ao Input (borda hairline,
 * foco bone, erro signal-orange, transição de 150 ms).
 */
const CONTROL_BASE =
  "flex w-full rounded-buttons border border-ash-stroke bg-carbon-lift px-3 text-body-sm text-bone outline-none transition-factory hover:border-graphite-mid focus-visible:border-bone disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-signal-orange aria-[invalid=true]:focus-visible:border-bone";
export const selectControlClassName = cn(CONTROL_BASE, "h-9 py-1");
export const textareaControlClassName = cn(
  CONTROL_BASE,
  "min-h-[72px] py-2 placeholder:text-warm-granite",
);

/**
 * Variante dos MESMOS controles para superfície clara (Dialog bg-bone): fundo
 * chalk, texto obsidian e borda graphite-mid (>= 3:1 sobre bone), com anel de
 * foco obsidian. Acrescente `inputLightClassName` ao <Input> do mesmo diálogo.
 * Os controles escuros acima continuam valendo para a superfície escura.
 */
const LIGHT_CONTROL =
  "border-graphite-mid bg-chalk text-obsidian-canvas placeholder:text-graphite-mid hover:border-obsidian-canvas focus-visible:border-obsidian-canvas focus-visible:ring-1 focus-visible:ring-obsidian-canvas aria-[invalid=true]:border-obsidian-canvas aria-[invalid=true]:focus-visible:border-obsidian-canvas [color-scheme:light]";
export const inputLightClassName = LIGHT_CONTROL;
export const selectControlLightClassName = cn(selectControlClassName, LIGHT_CONTROL);
export const textareaControlLightClassName = cn(textareaControlClassName, LIGHT_CONTROL);

/** Legenda padrão "* obrigatório" para o topo de formulários. */
export function RequiredLegend({ surface = "dark" }: { surface?: "dark" | "light" }) {
  return (
    <p className={cn("text-caption", surface === "light" ? "text-graphite-mid" : "text-warm-granite")}>
      Campos marcados com * são obrigatórios.
    </p>
  );
}
