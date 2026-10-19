"use client";

import { TriangleAlert } from "lucide-react";

import type { CatalogImportConfirmResponse } from "@/lib/catalog-imports-api";

// =============================================================================
// CatalogImportResult — resultado da confirmação. Só exibe o que o backend
// devolveu (contadores e falhas por item); aparece APÓS a resposta, nunca de
// forma otimista, e os números não são animados. As falhas trazem linha, nome e
// motivo (texto escapado pelo React); no máximo MAX_FAILURES são listadas.
// =============================================================================

const MAX_FAILURES = 100;

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="text-body text-bone" data-stat={label}>
        {value}
      </dd>
    </div>
  );
}

export function CatalogImportResult({ result }: { result: CatalogImportConfirmResponse }) {
  const failures = result.falhas ?? [];
  const hasFailures = failures.length > 0;
  return (
    <section
      aria-labelledby="catalog-result-title"
      data-testid="catalog-import-result"
      className={`flex flex-col gap-4 rounded-cards border bg-carbon-lift p-card-padding ${
        hasFailures ? "border-signal-orange/40" : "border-metric-green/40"
      }`}
    >
      <h2 id="catalog-result-title" className="text-eyebrow text-pale-stone">
        Resultado da importação
      </h2>
      <p role="status" className={`text-body-sm ${hasFailures ? "text-signal-orange" : "text-metric-green"}`}>
        {hasFailures
          ? "Importação concluída com falhas em alguns itens. Os demais foram gravados."
          : "Importação concluída com sucesso."}
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Criados" value={result.created} />
        <Stat label="Atualizados" value={result.updated} />
        <Stat label="Ignorados" value={result.ignorados} />
        <Stat label="Falhas" value={failures.length} />
      </dl>

      {hasFailures ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-eyebrow text-pale-stone">Falhas por item</h3>
          <ul className="flex flex-col gap-1.5 text-body-sm" data-testid="catalog-import-failures">
            {failures.slice(0, MAX_FAILURES).map((failure, index) => (
              <li
                key={`${failure.item_id ?? "item"}-${index}`}
                className="flex min-w-0 items-start gap-2 break-words [overflow-wrap:anywhere]"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
                <span>
                  {typeof failure.row === "number" ? `Linha ${failure.row}` : "Linha desconhecida"}
                  {failure.label ? ` — ${failure.label}` : ""}
                  {failure.reason ? `: ${failure.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {failures.length > MAX_FAILURES ? (
            <p className="text-caption text-warm-granite">
              e mais {failures.length - MAX_FAILURES} falha(s) não listadas.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-caption text-warm-granite">
        Para importar outra vez, gere uma nova prévia: a anterior foi consumida e não pode ser confirmada de novo.
      </p>
    </section>
  );
}
