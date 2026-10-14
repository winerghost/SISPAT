import type { LucideIcon } from "lucide-react";
import { CircleCheck, CirclePlus, Copy, GitCompare, OctagonX, Sigma } from "lucide-react";

import type { ImportItemClassification } from "@/lib/imports-api";

// =============================================================================
// Metadados visuais das classificações da prévia (fonte única para cards,
// badges da tabela e alertas). Ícone + texto em todos os lugares — a cor
// (metric-green = elegível/novo, signal-orange = exige revisão) nunca é o
// único sinal (WCAG 1.4.1). Só cores do DESIGN.md, apenas em texto/ícone/borda.
// =============================================================================

export type ClassificationTone = "neutral" | "success" | "warning";

export interface ClassificationMeta {
  label: string;
  icon: LucideIcon;
  tone: ClassificationTone;
  badge: "success" | "outline" | "warning";
}

export const CLASSIFICATION_META: Record<ImportItemClassification, ClassificationMeta> = {
  NOVO: { label: "Novo", icon: CirclePlus, tone: "success", badge: "success" },
  EXISTENTE: { label: "Existente", icon: CircleCheck, tone: "neutral", badge: "outline" },
  DUPLICADO: { label: "Duplicado", icon: Copy, tone: "warning", badge: "warning" },
  INVALIDO: { label: "Inválido", icon: OctagonX, tone: "warning", badge: "warning" },
  CONFLITANTE: { label: "Conflitante", icon: GitCompare, tone: "warning", badge: "warning" },
};

export const TOTAL_META: Pick<ClassificationMeta, "label" | "icon" | "tone"> = {
  label: "Total",
  icon: Sigma,
  tone: "neutral",
};

export const TONE_TEXT_CLASS: Record<ClassificationTone, string> = {
  neutral: "text-bone",
  success: "text-metric-green",
  warning: "text-signal-orange",
};
