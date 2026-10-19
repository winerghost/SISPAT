"use client";

import { Check, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { StatusIndicator } from "@/components/ui/status-indicator";
import type { UnitRef } from "@/lib/users-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";

// =============================================================================
// Peças compartilhadas das telas de cadastros de apoio: cabeçalho, selo de
// situação (ícone + texto, nunca só cor), paginação, painel de erro/negação e
// rótulo de unidade. Apresentação apenas.
// =============================================================================

export function CatalogHeader({
  title,
  description,
  action,
  eyebrow = "Administração · Cadastros de apoio",
}: {
  title: string;
  description: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">{eyebrow}</span>
        <h1 className="text-heading text-bone">{title}</h1>
        <p className="max-w-page text-body-sm text-warm-granite">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function ActiveBadge({
  active,
  feminine = true,
  surface = "dark",
}: {
  active: boolean;
  feminine?: boolean;
  /** "light" = dentro do Dialog (bone): metric-green não tem contraste ali, então texto escuro + ícone. */
  surface?: "dark" | "light";
}) {
  const label = active ? (feminine ? "Ativa" : "Ativo") : feminine ? "Inativa" : "Inativo";
  const icon = active ? <Check aria-hidden="true" /> : <CircleSlash aria-hidden="true" />;
  if (surface === "light") {
    return (
      <Badge variant="default" className="border-graphite-mid text-obsidian-canvas">
        {icon}
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant={active ? "success" : "default"}>
      {icon}
      {label}
    </Badge>
  );
}

/** Painel de aviso/erro (negação de acesso, falha de carga) com ação opcional. */
export function CatalogNotice({
  children,
  onRetry,
  retrying = false,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <SlideIn distance="sm">
      <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
        <FormMessage>{children}</FormMessage>
        {onRetry ? (
          <Button variant="outline" size="sm" className="self-start" loading={retrying} onClick={onRetry}>
            Tentar novamente
          </Button>
        ) : null}
      </div>
    </SlideIn>
  );
}

export function CatalogPagination({
  page,
  total,
  pageSize,
  noun,
  loading,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  /** Ex.: "sala(s)". */
  noun: string;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-body-sm text-warm-granite" aria-live="polite">
          Página {page} de {totalPages} · {total} {noun}
        </span>
        {loading ? <StatusIndicator state="loading" label="Carregando…" /> : null}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => onPage(Math.max(1, page - 1))}>
          Anterior
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)}>
          Próxima
        </Button>
      </div>
    </div>
  );
}

/** Unidade da linha: "SIGLA — Nome" quando conhecida; senão texto neutro. */
export function unitText(unitId: string, units: UnitRef[] | undefined): string {
  const unit = units?.find((candidate) => candidate.id === unitId);
  return unit ? unitLabel(unit) : "Unidade inativa ou fora da lista";
}

/** Campo somente leitura em formulário de edição (unidade, sigla, ID de origem). */
export function ReadOnlyField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-eyebrow text-graphite-mid">{label}</span>
      <p className="break-words text-body-sm text-obsidian-canvas [overflow-wrap:anywhere]">{children}</p>
    </div>
  );
}
