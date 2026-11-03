"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import type { SeriesStyle } from "@/components/dashboard/chart-shell";
import { TOKENS } from "@/components/dashboard/chart-theme";
import { StatCard } from "@/components/dashboard/stat-card";
import type { ChartDatum } from "@/components/dashboard/types";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SummaryData } from "@/lib/dashboard-equipment-api";

import { formatCount, formatPercent } from "./equipment-format";

// =============================================================================
// Painel `located_summary`: rosca com o quantitativo GLOBAL de bens por
// situação de localização (Localizados / Não localizados / Não informado). Só
// apresentação: contagem, percentual e total são EXATAMENTE os do backend —
// nada é somado, dividido, arredondado ou estimado aqui, e `total = 0` é
// tratado como vazio honesto pelo próprio painel (equipment-panels.tsx).
//
// - Cor + textura + legenda + tabela de dados: a série nunca depende só de cor
//   (verde liso / laranja listrado / cinza pontilhado — os mesmos estilos de
//   `located-chart-view.tsx`, tokens funcionais do DESIGN.md, todos >= 3:1
//   sobre o canvas).
// - Série com `value: 0` ENTRA na rosca: ela precisa existir na legenda e na
//   tabela (o caso real é "Não informado" com 0), e a legenda do ChartShell é
//   construída a partir dos dados do gráfico. Uma fatia de ângulo zero não
//   desenha área; sobra apenas o traço separador na cor do fundo (#101010),
//   idêntico aos separadores entre fatias — ou seja, zero não ganha marca
//   visível que pudesse ser lida como "um pouco".
// - Sem clique/seleção na rosca: este painel NÃO tem endpoint de registros (o
//   backend responde 404 em `/records` de propósito) e `/patrimonios` não
//   aceita a situação de localização como parâmetro de URL (só `busca` e
//   `page`, ver use-asset-filters.ts) — inventar `?localizado=` seria inventar
//   contrato. O caminho honesto para a lista é o filtro "Localizado" da
//   própria tela de Patrimônios; o acesso por teclado ao conteúdo do painel é
//   a legenda, a tabela visível e a tabela alternativa do gráfico.
// - Nada é animado além do FadeIn do painel e do contador do StatCard, que
//   parte do número já confirmado pelo backend.
// =============================================================================

const Donut = dynamic(() => import("@/components/dashboard/nivo-pie-chart").then((m) => m.PieChart), {
  ssr: false,
  loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" />,
});

/** Cor semântica + textura por situação (constante: a cor segue a entidade). */
const SERIES_STYLES: Readonly<Record<string, SeriesStyle>> = {
  SIM: { color: TOKENS.green, pattern: "solid" },
  NAO: { color: TOKENS.orange, pattern: "lines" },
  DESCONHECIDO: { color: TOKENS.granite, pattern: "dots" },
};

export function LocatedSummaryView({ dados, label }: { dados: SummaryData; label: string }) {
  const data: ChartDatum[] = dados.series.map((s) => ({ key: s.id, label: s.label, value: s.value }));
  const caption = `${label} (dados do gráfico)`;
  const hasZero = dados.series.some((s) => s.value === 0);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-located-summary>
      <Donut
        kind="donut"
        title={label}
        description="Todos os bens visíveis ao seu perfil."
        data={data}
        valueLabel="Bens"
        valueFormatter={formatCount}
        categoryStyles={SERIES_STYLES}
        className="border-0 p-0"
      />

      <div className="max-w-xs">
        <StatCard
          stat={{
            id: "located-summary-total",
            label: "Total de bens",
            value: dados.total,
            description: "Total apurado pelo servidor para as três situações.",
          }}
          className="rounded-cards p-3 sm:p-4"
        />
      </div>

      {/* Tabela de dados (>= lg) — alternativa visível à rosca. */}
      <div className="min-w-0" data-located-summary-matrix>
        <div className="hidden lg:block">
          <Table regionLabel={`${caption} (rolável)`}>
            <caption className="sr-only">{caption}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Situação</TableHead>
                <TableHead scope="col" className="text-right">
                  Bens
                </TableHead>
                <TableHead scope="col" className="text-right">
                  % do total
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dados.series.map((serie) => (
                <TableRow key={serie.id} data-located-summary-row={serie.id}>
                  <th scope="row" className="px-4 py-[var(--density-cell-y)] text-left align-middle font-regular break-words text-bone">
                    {serie.label}
                  </th>
                  <TableCell className="text-right tabular-nums">{formatCount(serie.value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(serie.percentual)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow data-located-summary-totals>
                <th scope="row" className="px-4 py-[var(--density-cell-y)] text-left align-middle font-regular text-bone">
                  Total
                </th>
                <TableCell className="text-right tabular-nums">{formatCount(dados.total)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(null)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>

        {/* Cartões (< lg): mesma informação, uma coluna no celular. */}
        <ul aria-label={caption} className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:hidden">
          {dados.series.map((serie) => (
            <li
              key={serie.id}
              data-located-summary-card={serie.id}
              className="min-w-0 rounded-cards border border-carbon-lift p-3"
            >
              <p className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">{serie.label}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <dt className="text-caption text-warm-granite">Bens</dt>
                  <dd className="m-0 tabular-nums text-bone">{formatCount(serie.value)}</dd>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <dt className="text-caption text-warm-granite">% do total</dt>
                  <dd className="m-0 tabular-nums text-bone">{formatPercent(serie.percentual)}</dd>
                </div>
              </dl>
            </li>
          ))}
          <li data-located-summary-totals className="min-w-0 rounded-cards border border-ash-stroke p-3">
            <p className="text-body-sm text-bone">Total</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-col items-start gap-1">
                <dt className="text-caption text-warm-granite">Bens</dt>
                <dd className="m-0 tabular-nums text-bone">{formatCount(dados.total)}</dd>
              </div>
              <div className="flex min-w-0 flex-col items-start gap-1">
                <dt className="text-caption text-warm-granite">% do total</dt>
                <dd className="m-0 tabular-nums text-bone">{formatPercent(null)}</dd>
              </div>
            </dl>
          </li>
        </ul>
      </div>

      <p className="text-body-sm text-warm-granite">
        O percentual de cada situação é o que o servidor calculou; o total não tem percentual próprio (“—”).
        {hasZero ? (
          <span data-located-summary-zero>
            {" "}
            Situação com zero bens aparece na legenda e na tabela, sem fatia visível na rosca.
          </span>
        ) : null}
      </p>
      <p className="text-body-sm text-warm-granite" data-located-summary-hint>
        Este painel não abre listas. Para ver os bens de uma situação, use o filtro “Localizado” em Patrimônios.
      </p>
      <Link
        href="/patrimonios"
        data-located-summary-link
        className="inline-flex h-9 w-fit items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
      >
        Abrir a lista de bens
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
