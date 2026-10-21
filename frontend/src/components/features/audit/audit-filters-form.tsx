"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  AUDIT_MAX_WINDOW_DAYS,
  AUDIT_RESULTS,
  AUDIT_SEVERITIES,
  validateAuditDraft,
  type AuditFilters,
  type AuditResult,
  type AuditSeverity,
} from "@/lib/audit-filters";
import { RESULT_LABEL, SEVERITY_LABEL } from "./audit-labels";

// =============================================================================
// Filtros da auditoria. O formulário edita um RASCUNHO; "Aplicar filtros" valida
// por forma (UX) e grava na URL (via `onApply`). Quem valida de verdade é o
// backend (400). Datas: <input type="date"> nativo, interpretadas em
// America/Araguaina; sem datas a consulta cobre os últimos 30 dias.
// O pai troca a `key` quando a URL muda, reiniciando o rascunho.
// =============================================================================

interface Draft {
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string;
  result: AuditResult | "";
  severity: AuditSeverity | "";
  from: string;
  to: string;
}

function toDraft(filters: AuditFilters): Draft {
  return {
    event_type: filters.event_type ?? "",
    entity_type: filters.entity_type ?? "",
    entity_id: filters.entity_id ?? "",
    actor_user_id: filters.actor_user_id ?? "",
    result: filters.result ?? "",
    severity: filters.severity ?? "",
    from: filters.from ?? "",
    to: filters.to ?? "",
  };
}

export interface AuditFiltersFormProps {
  applied: AuditFilters;
  hasFilters: boolean;
  onApply: (next: Omit<AuditFilters, "sort">) => void;
  onClear: () => void;
}

export function AuditFiltersForm({ applied, hasFilters, onApply, onClear }: AuditFiltersFormProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(applied));
  const [errors, setErrors] = useState<ReturnType<typeof validateAuditDraft>>({});

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = {
      ...draft,
      event_type: draft.event_type.trim(),
      entity_type: draft.entity_type.trim(),
      entity_id: draft.entity_id.trim(),
      actor_user_id: draft.actor_user_id.trim(),
    };
    const found = validateAuditDraft(trimmed);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onApply({
      event_type: trimmed.event_type || undefined,
      entity_type: trimmed.entity_type || undefined,
      entity_id: trimmed.entity_id || undefined,
      actor_user_id: trimmed.actor_user_id ? trimmed.actor_user_id.toLowerCase() : undefined,
      result: trimmed.result || undefined,
      severity: trimmed.severity || undefined,
      from: trimmed.from || undefined,
      to: trimmed.to || undefined,
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Filtros da auditoria" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FormField label="Evento" hint="Código, ex.: USER_ROLE_CHANGED" error={errors.event_type}>
          {(field) => (
            <Input
              {...field}
              maxLength={64}
              autoComplete="off"
              value={draft.event_type}
              onChange={(e) => set("event_type", e.target.value.toUpperCase())}
            />
          )}
        </FormField>
        <FormField label="Tipo de entidade" hint="Ex.: user, unit" error={errors.entity_type}>
          {(field) => (
            <Input
              {...field}
              maxLength={40}
              autoComplete="off"
              value={draft.entity_type}
              onChange={(e) => set("entity_type", e.target.value.toLowerCase())}
            />
          )}
        </FormField>
        <FormField label="ID da entidade" error={errors.entity_id}>
          {(field) => (
            <Input
              {...field}
              maxLength={100}
              autoComplete="off"
              value={draft.entity_id}
              onChange={(e) => set("entity_id", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Autor (ID do usuário)" error={errors.actor_user_id}>
          {(field) => (
            <Input
              {...field}
              maxLength={36}
              autoComplete="off"
              value={draft.actor_user_id}
              onChange={(e) => set("actor_user_id", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Resultado">
          {(field) => (
            <select
              {...field}
              className={selectControlClassName}
              value={draft.result}
              onChange={(e) => set("result", e.target.value as AuditResult | "")}
            >
              <option value="">Todos</option>
              {AUDIT_RESULTS.map((value) => (
                <option key={value} value={value}>
                  {RESULT_LABEL[value]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Severidade" hint="Só eventos de segurança">
          {(field) => (
            <select
              {...field}
              className={selectControlClassName}
              value={draft.severity}
              onChange={(e) => set("severity", e.target.value as AuditSeverity | "")}
            >
              <option value="">Todas</option>
              {AUDIT_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {SEVERITY_LABEL[value]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="De (data)" error={errors.period}>
          {(field) => (
            <Input {...field} type="date" className="[color-scheme:dark]" value={draft.from} onChange={(e) => set("from", e.target.value)} />
          )}
        </FormField>
        <FormField
          label="Até (data)"
          hint={`Período máximo de ${AUDIT_MAX_WINDOW_DAYS} dias; padrão: últimos 30.`}
        >
          {(field) => <Input {...field} type="date" className="[color-scheme:dark]" value={draft.to} onChange={(e) => set("to", e.target.value)} />}
        </FormField>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm">
          Aplicar filtros
        </Button>
        {hasFilters ? (
          <Button type="button" variant="link" size="sm" className="min-h-8" onClick={onClear}>
            Limpar filtros
          </Button>
        ) : null}
      </div>
    </form>
  );
}
