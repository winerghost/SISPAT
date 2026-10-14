"use client";

import { TriangleAlert } from "lucide-react";

import { SlideIn } from "@/components/animations";
import type { ImportPreviewSummary } from "@/lib/imports-api";

import { CLASSIFICATION_META } from "./classification";

// =============================================================================
// PreviewReviewAlert — aviso discreto quando a prévia tem registros que NÃO
// podem ser importados (duplicado/inválido/conflitante). É informação, não
// erro: `role="status"` (polite), entrada fade + 4px. Ícone + texto; laranja
// só em borda/ícone (DESIGN.md: signal-orange é voz de estado).
// Valores vêm do `summary` real do backend — não renderiza nada se zero.
// =============================================================================

export function PreviewReviewAlert({ summary }: { summary: ImportPreviewSummary }) {
  const parts = (
    [
      ["DUPLICADO", summary.duplicado],
      ["INVALIDO", summary.invalido],
      ["CONFLITANTE", summary.conflitante],
    ] as const
  ).filter(([, count]) => count > 0);

  const total = parts.reduce((acc, [, count]) => acc + count, 0);
  if (total === 0) return null;

  return (
    <SlideIn distance="sm">
      <div
        role="status"
        className="flex items-start gap-3 rounded-cards border border-signal-orange/40 p-4"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-body-sm text-bone">
            {total} registro(s) exigem revisão na planilha de origem e não podem ser selecionados.
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-pale-stone">
            {parts.map(([key, count]) => {
              const meta = CLASSIFICATION_META[key];
              const Icon = meta.icon;
              return (
                <li key={key} className="inline-flex items-center gap-1.5">
                  <Icon className="h-3 w-3 shrink-0 text-signal-orange" aria-hidden="true" />
                  <span>
                    {meta.label}: {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </SlideIn>
  );
}
