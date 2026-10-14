"use client";

import { AnimatedCounter, StaggerContainer, StaggerItem } from "@/components/animations";
import { cn } from "@/lib/utils";
import type { ImportPreviewSummary } from "@/lib/imports-api";

import {
  CLASSIFICATION_META,
  TONE_TEXT_CLASS,
  TOTAL_META,
  type ClassificationMeta,
} from "./classification";

// =============================================================================
// PreviewSummaryCards
// =============================================================================
// Indicadores quantitativos da prévia de importação, no estilo "Metric Tile"
// do DESIGN.md: sem fundo, divisor hairline carbon-lift, rótulo Geist Mono
// 12px uppercase (pale-stone) e valor Geist 36px. Cores funcionais restritas
// à paleta: metric-green (Novo), signal-orange (Duplicado/Inválido/
// Conflitante) — só texto/ícone, nunca fill. Cada card traz ícone + rótulo.
//
// Motion: entrada escalonada (6 itens, 30 ms) e AnimatedCounter 0 → valor
// REAL devolvido pelo backend (`summary`), terminando no valor exato; sob
// reduced motion o valor final aparece imediatamente. `live="off"` nos
// contadores: a grade inteira não é relida a cada número; o leitor de tela lê
// rótulo + cópia sr-only do valor final (o número animado é aria-hidden).
// =============================================================================

const METRICS: Array<{
  key: keyof ImportPreviewSummary;
  meta: Pick<ClassificationMeta, "label" | "icon" | "tone">;
}> = [
  { key: "total", meta: TOTAL_META },
  { key: "novo", meta: CLASSIFICATION_META.NOVO },
  { key: "existente", meta: CLASSIFICATION_META.EXISTENTE },
  { key: "duplicado", meta: CLASSIFICATION_META.DUPLICADO },
  { key: "invalido", meta: CLASSIFICATION_META.INVALIDO },
  { key: "conflitante", meta: CLASSIFICATION_META.CONFLITANTE },
];

interface PreviewSummaryCardsProps {
  summary: ImportPreviewSummary;
}

export function PreviewSummaryCards({ summary }: PreviewSummaryCardsProps) {
  return (
    <StaggerContainer
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
      role="group"
      aria-label="Resumo quantitativo da pré-visualização"
    >
      {METRICS.map(({ key, meta }, index) => {
        const Icon = meta.icon;
        return (
          <StaggerItem
            key={key}
            index={index}
            data-metric={key}
            className="flex flex-col gap-2 rounded-cards border border-carbon-lift p-5 transition-factory hover:border-ash-stroke"
          >
            <span className="flex items-center gap-1.5 text-eyebrow text-pale-stone">
              <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT_CLASS[meta.tone])} aria-hidden="true" />
              {meta.label}
            </span>
            <AnimatedCounter
              value={summary[key]}
              live="off"
              className={cn("text-heading", TONE_TEXT_CLASS[meta.tone])}
            />
          </StaggerItem>
        );
      })}
    </StaggerContainer>
  );
}
