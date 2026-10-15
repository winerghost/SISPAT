import type { Density, FontScale } from "@/lib/ui-preferences";

// =============================================================================
// Prévia da Aparência. Mostra como ficam espaçamento e texto com a ESCOLHA
// ATUAL do rascunho (ainda não salva). O espaçamento usa as mesmas variáveis
// da UI real (o atributo `data-density` no cartão aplica o override de
// globals.css); o texto usa a escala 12/14/16 do DESIGN.md x fator, em px
// absolutos para não depender da escala já aplicada ao <html>.
// Dados do exemplo são fictícios e rotulados como tal.
// =============================================================================

const BASE = { caption: 12, bodySm: 14, body: 16 } as const;

function px(base: number, scale: FontScale): string {
  return `${Math.round(((base * scale) / 100) * 100) / 100}px`;
}

const SAMPLE_ROWS = [
  { code: "0000001", name: "Item de exemplo A", state: "Conferido" },
  { code: "0000002", name: "Item de exemplo B", state: "Pendente" },
];

export function AppearancePreview({ density, fontScale }: { density: Density; fontScale: FontScale }) {
  return (
    <section
      aria-labelledby="aparencia-previa-titulo"
      data-testid="aparencia-previa"
      data-density={density}
      data-font-scale={fontScale}
      className="flex flex-col gap-element-gap rounded-cards border border-ash-stroke p-card-padding"
    >
      <h2 id="aparencia-previa-titulo" className="text-body text-bone">
        Prévia
      </h2>
      <div className="flex flex-col gap-element-gap rounded-cards border border-ash-stroke p-card-padding">
        <span className="text-eyebrow text-pale-stone" style={{ fontSize: px(BASE.caption, fontScale) }}>
          Exemplo · não são dados reais
        </span>
        <p className="text-bone" style={{ fontSize: px(BASE.body, fontScale), lineHeight: 1.5 }}>
          Texto de leitura em tamanho {fontScale}%.
        </p>
        <p className="text-warm-granite" style={{ fontSize: px(BASE.bodySm, fontScale), lineHeight: 1.43 }}>
          Texto secundário e rótulos seguem a mesma proporção.
        </p>
        <ul className="flex flex-col" aria-label="Linhas de exemplo">
          {SAMPLE_ROWS.map((row) => (
            <li
              key={row.code}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-ash-stroke py-[var(--density-cell-y)] text-bone"
              style={{ fontSize: px(BASE.bodySm, fontScale) }}
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {row.code} — {row.name}
              </span>
              <span className="text-pale-stone">{row.state}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
