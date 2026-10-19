"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { CatalogImportReport } from "@/lib/catalog-imports-api";

import { pendingLabel, toTextList } from "./catalog-import-labels";

// =============================================================================
// CatalogImportReportView — relatório da prévia de cadastros: pendências por
// código, IDs repetidos, nomes suspeitos e prováveis duplicatas. Só leitura e
// só texto (escapado pelo React). Os números vêm do backend e NÃO são animados.
// Ícone + texto (a cor nunca é o único sinal). Listas semânticas, sem tabela:
// quebram linha em 320px sem rolagem horizontal. Nomes de pessoas aparecem aqui
// só porque o backend os devolveu para revisão; nada é persistido no navegador.
// =============================================================================

function Block({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={`${title}: ${count}`}>
      <h3 className="text-eyebrow text-pale-stone">
        {title} <span className="text-bone">({count})</span>
      </h3>
      {children}
    </section>
  );
}

const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";

function rowsText(rows: (number | null)[]): string {
  const known = rows.filter((row): row is number => typeof row === "number");
  return known.length > 0 ? `linha${known.length > 1 ? "s" : ""} ${known.join(", ")}` : "linha desconhecida";
}

export function CatalogImportReportView({ report }: { report: CatalogImportReport }) {
  const pending = Object.entries(report.pendencias ?? {}).filter(([, count]) => count > 0);
  const totalPending = pending.reduce((sum, [, count]) => sum + count, 0);
  const repeated = report.ids_repetidos ?? [];
  const suspects = report.nomes_suspeitos ?? [];
  const duplicates = report.provaveis_duplicatas ?? [];
  const clean = totalPending === 0 && repeated.length === 0 && suspects.length === 0 && duplicates.length === 0;

  return (
    <section
      aria-labelledby="catalog-report-title"
      data-testid="catalog-import-report"
      className="flex flex-col gap-5 rounded-cards border border-carbon-lift p-card-padding"
    >
      <div className="flex flex-col gap-1">
        <h2 id="catalog-report-title" className="text-eyebrow text-pale-stone">
          Relatório da prévia
        </h2>
        <p className="text-body-sm text-warm-granite">
          Itens listados abaixo exigem revisão humana na planilha de origem. O sistema não corrige nomes nem
          chuta vínculos.
        </p>
      </div>

      {clean ? (
        <p role="status" className="inline-flex items-center gap-2 text-body-sm text-metric-green">
          <CircleCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Nenhuma pendência, ID repetido, nome suspeito ou provável duplicata encontrados.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Block title="Pendências por código" count={totalPending}>
            {pending.length === 0 ? (
              <p className="text-body-sm text-warm-granite">Nenhuma pendência.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-body-sm">
                {pending.map(([code, count]) => (
                  <li key={code} className="flex items-start gap-2" data-pending-code={code}>
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
                    <span className={WRAP}>
                      {pendingLabel(code)}: <span className="text-bone">{count}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="IDs repetidos" count={repeated.length}>
            {repeated.length === 0 ? (
              <p className="text-body-sm text-warm-granite">Nenhum ID repetido.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-body-sm">
                {repeated.map((entry, index) => (
                  <li key={`${entry.id}-${index}`} className={WRAP}>
                    ID <span className="text-bone">{entry.id}</span> em {rowsText(entry.linhas)}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="Nomes suspeitos" count={suspects.length}>
            {suspects.length === 0 ? (
              <p className="text-body-sm text-warm-granite">Nenhum nome suspeito.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-body-sm">
                {suspects.map((entry, index) => (
                  <li key={index} className={WRAP}>
                    <span className="text-bone">{entry.name ?? "(sem nome)"}</span> ({rowsText([entry.row])})
                    {toTextList(entry.reasons).length > 0 ? (
                      <span className="text-warm-granite"> — {toTextList(entry.reasons).join("; ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="Prováveis duplicatas" count={duplicates.length}>
            {duplicates.length === 0 ? (
              <p className="text-body-sm text-warm-granite">Nenhuma provável duplicata.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-body-sm">
                {duplicates.map((group, index) => (
                  <li key={index} className={WRAP}>
                    <span className="text-bone">{group.names.filter(Boolean).join(" ≈ ") || "(sem nome)"}</span> (
                    {rowsText(group.rows)})
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>
      )}
    </section>
  );
}
