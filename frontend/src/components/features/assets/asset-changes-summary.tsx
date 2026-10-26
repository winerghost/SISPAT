"use client";

// =============================================================================
// Resumo das alterações do formulário de edição: "Campo: antigo → novo", só dos
// campos que realmente irão no PATCH (a lista vem do mesmo cálculo que monta o
// corpo da requisição). <details> nativo: teclado e leitor de tela sem JS extra.
// Texto puro (React escapa). Superfície clara do Dialog.
// =============================================================================

export interface ChangeSummaryItem {
  key: string;
  label: string;
  before: string;
  after: string;
}

/** "1 campo alterado" / "3 campos alterados". */
export function changedCountLabel(count: number): string {
  return `${count} ${count === 1 ? "campo alterado" : "campos alterados"}`;
}

export function AssetChangesSummary({ items }: { items: readonly ChangeSummaryItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="group rounded-cards border border-graphite-mid/40 px-4 text-body-sm text-obsidian-canvas">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-buttons focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas">
        <span>{changedCountLabel(items.length)}</span>
        <span className="text-eyebrow text-graphite-mid">
          <span className="group-open:hidden">Ver resumo</span>
          <span className="hidden group-open:inline">Ocultar resumo</span>
        </span>
      </summary>
      <ul aria-label="Resumo das alterações" className="flex flex-col gap-2 pb-3 pt-1">
        {items.map((item) => (
          <li key={item.key} className="break-words [overflow-wrap:anywhere]">
            <span className="font-medium">{item.label}</span>: {item.before} → {item.after}
          </li>
        ))}
      </ul>
    </details>
  );
}
