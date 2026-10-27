"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";

import { StatCard } from "@/components/dashboard/stat-card";
import type { DashboardStat, MultiSeriesChartData } from "@/components/dashboard/types";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import type {
  CardsData,
  CategoryShare,
  ChartData,
  DistributionData,
  OverridesData,
  PanelData,
  QueueSummaryData,
  RankingData,
  RatioData,
  Share,
  SyncStatusData,
  TableData,
  UnitRow,
} from "@/lib/dashboard-equipment-api";

import { DataMatrix, type MatrixRow } from "./equipment-data-matrix";
import {
  formatCount,
  formatPercent,
  formatWhen,
  jobStatusLabel,
  rankingMethodNote,
} from "./equipment-format";

// =============================================================================
// Visões por `tipo` dos painéis do catálogo. Só apresentação: cada número é o
// que o backend devolveu (contagens, totais, percentuais, razões). Nada é
// somado, arredondado ou estimado aqui; `null` aparece como "—".
// =============================================================================

const GroupedBars = dynamic(
  () => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedGroupedBarChart),
  { ssr: false, loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" /> },
);

const toStat = (item: { id: string; label: string; value: number }): DashboardStat => ({
  id: item.id.toLowerCase(),
  label: item.label,
  value: item.value,
});

function StatGrid({ label, stats }: { label: string; stats: DashboardStat[] }) {
  return (
    <ul aria-label={label} className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
      {stats.map((stat) => (
        <li key={stat.id} className="min-w-0">
          <StatCard stat={stat} className="h-full rounded-cards p-3 sm:p-4" />
        </li>
      ))}
    </ul>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-body-sm text-warm-granite">{children}</p>
);

// ---------------------------------------------------------------------------
// cartoes
// ---------------------------------------------------------------------------

function CardsView({ dados, label }: { dados: CardsData; label: string }) {
  return (
    <div className="flex flex-col gap-3">
      <StatGrid label={label} stats={dados.itens.map(toStat)} />
      <Note>Total do grupo: {formatCount(dados.total)}</Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// tabela (e tabela de dados do gráfico)
// ---------------------------------------------------------------------------

function unitMatrixRows(linhas: UnitRow[], colunas: { id: string }[]): MatrixRow[] {
  return linhas.map((linha, i) => ({
    key: `${i}:${linha.unidade}`,
    label: linha.unidade,
    cells: [formatCount(linha.total), ...colunas.map((c) => formatCount(linha.valores[c.id] ?? 0))],
  }));
}

function UnitMatrix({ caption, colunas, linhas, total }: { caption: string; colunas: { id: string; label: string }[]; linhas: UnitRow[]; total: number }) {
  return (
    <div className="flex flex-col gap-3">
      <DataMatrix
        caption={caption}
        rowHeader="Unidade"
        columns={[{ id: "__total", label: "Total" }, ...colunas]}
        rows={unitMatrixRows(linhas, colunas)}
      />
      <Note>Total geral: {formatCount(total)}</Note>
    </div>
  );
}

function TableView({ dados, label }: { dados: TableData; label: string }) {
  return <UnitMatrix caption={label} colunas={dados.colunas} linhas={dados.linhas} total={dados.total} />;
}

// ---------------------------------------------------------------------------
// grafico (barras agrupadas + tabela de dados visível)
// ---------------------------------------------------------------------------

function chartModel(dados: ChartData): MultiSeriesChartData {
  const categories = dados.unidades.map((u, i) => ({ key: `u${i}`, label: u.unidade }));
  return {
    categories,
    series: dados.series.map((s) => ({
      key: s.id,
      label: s.label,
      values: Object.fromEntries(dados.unidades.map((u, i) => [`u${i}`, u.valores[s.id]])),
    })),
  };
}

function ChartView({ dados, label }: { dados: ChartData; label: string }) {
  return (
    <div className="flex flex-col gap-3">
      <GroupedBars
        title={`${label}: ${dados.familia_label}`}
        description="Até 15 unidades; as demais somadas em “Outras”."
        data={chartModel(dados)}
        valueFormatter={formatCount}
        className="border-0 p-0"
      />
      <Note>Total exibido: {formatCount(dados.total)}</Note>
      {/* Alternativa visível ao gráfico: as cores se repetem a partir da 5ª série. */}
      <details className="group rounded-cards border border-carbon-lift">
        <summary className="cursor-pointer rounded-cards px-3 py-2 text-body-sm text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone">
          Ver os dados do gráfico em tabela
        </summary>
        <div className="p-3">
          <UnitMatrix caption={`${label} (dados do gráfico)`} colunas={dados.series} linhas={dados.unidades} total={dados.total} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// distribuicao
// ---------------------------------------------------------------------------

function ShareList({ title, items }: { title: string; items: (Share | CategoryShare)[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-eyebrow text-pale-stone">{title}</h4>
      <ul aria-label={title} className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => (
          <li key={item.id} className="min-w-0" data-share-item={item.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 break-words text-body-sm text-bone">{item.label}</span>
              <span className="text-body-sm tabular-nums text-warm-granite">
                {formatCount(item.value)} · {formatPercent(item.percentual)}
              </span>
            </div>
            {/* Trilho decorativo: o valor está no texto ao lado (cor/largura nunca são a única pista). */}
            <div aria-hidden="true" className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-carbon-lift">
              <div
                className="h-full rounded-full bg-bone"
                style={{ width: `${Math.min(100, Math.max(0, item.percentual ?? 0))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DistributionView({ dados }: { dados: DistributionData }) {
  return (
    <div className="flex flex-col gap-4">
      <Note>Total de bens: {formatCount(dados.total)}</Note>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ShareList title="Por família" items={dados.familias} />
        <ShareList title="Por categoria" items={dados.categorias} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ranking (estimativa)
// ---------------------------------------------------------------------------

function RankingView({ dados, label }: { dados: RankingData; label: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p
        role="note"
        data-estimate-notice
        className="flex items-start gap-2 rounded-cards border border-ash-stroke p-3 text-body-sm text-bone"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
        <span>{rankingMethodNote(dados.metodo)}</span>
      </p>
      <StatGrid
        label={`${label}: totais`}
        stats={[
          { id: "rk-notebooks", label: "Notebooks", value: dados.notebooks },
          { id: "rk-docking", label: "Docking stations", value: dados.docking },
          { id: "rk-sem-docking", label: "Sem docking (estimativa)", value: dados.sem_docking },
        ]}
      />
      <DataMatrix
        caption={`${label} (estimativa por unidade)`}
        rowHeader="Unidade"
        columns={[
          { id: "notebooks", label: "Notebooks" },
          { id: "docking", label: "Docking" },
          { id: "sem_docking", label: "Sem docking (est.)" },
        ]}
        rows={dados.por_unidade.map((r, i) => ({
          key: `${i}:${r.unidade}`,
          label: r.unidade,
          cells: [formatCount(r.notebooks), formatCount(r.docking), formatCount(r.sem_docking)],
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// razao
// ---------------------------------------------------------------------------

function RatioView({ dados, label }: { dados: RatioData; label: string }) {
  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        label={label}
        stats={[
          { id: "rz-computadores", label: "Computadores", value: dados.computadores },
          { id: "rz-notebooks", label: "Notebooks", value: dados.notebooks },
          { id: "rz-monitores", label: "Monitores", value: dados.monitores },
          {
            id: "rz-por-computador",
            label: "Monitores por computador",
            value: dados.monitores_por_computador,
            decimals: 2,
          },
          {
            id: "rz-por-notebook",
            label: "Monitores por notebook",
            value: dados.monitores_por_notebook,
            decimals: 2,
          },
        ]}
      />
      {dados.monitores_por_computador === null || dados.monitores_por_notebook === null ? (
        <Note>“—” indica que não há computadores ou notebooks para dividir: a razão não é calculada.</Note>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// fila (indicador de pendentes de revisão)
// ---------------------------------------------------------------------------

function QueueView({ dados, label }: { dados: QueueSummaryData; label: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-xs">
        <StatCard
          stat={{
            id: "fila-pendentes",
            label: "Pendentes de revisão",
            value: dados.total_pendentes,
            description: "Bens de categoria “Outros” com confiança baixa, sem correção manual.",
          }}
          className="rounded-cards p-3 sm:p-4"
        />
      </div>
      {dados.por_unidade.length > 0 ? (
        <DataMatrix
          caption={`${label} por unidade`}
          rowHeader="Unidade"
          columns={[{ id: "value", label: "Pendentes" }]}
          rows={dados.por_unidade.map((r, i) => ({
            key: `${i}:${r.unidade}`,
            label: r.unidade,
            cells: [formatCount(r.value)],
          }))}
        />
      ) : null}
      <Link
        href="/dashboard/classificacao"
        data-review-link
        className="inline-flex h-9 w-fit items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:border-chalk hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
      >
        Revisar fila de classificação
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// lista (últimas correções)
// ---------------------------------------------------------------------------

function OverridesView({ dados, label }: { dados: OverridesData; label: string }) {
  return (
    <div className="flex flex-col gap-4">
      <StatGrid
        label={`${label}: total`}
        stats={[{ id: "ov-total", label: "Correções manuais ativas", value: dados.total }]}
      />
      {dados.por_categoria.length > 0 ? (
        <CategoryChips title="Por categoria corrigida" items={dados.por_categoria} />
      ) : null}
      {dados.recentes.length > 0 ? (
        <DataMatrix
          caption={`${label}: mais recentes`}
          rowHeader="Patrimônio"
          columns={[
            { id: "description", label: "Descrição" },
            { id: "change", label: "Categoria" },
            { id: "when", label: "Em" },
          ]}
          rows={dados.recentes.map((r, i) => ({
            key: `${i}:${r.asset_id}`,
            label: r.patrimony_number,
            cells: [
              r.description ?? "—",
              `${r.categoria_anterior ?? "Não classificado"} → ${r.categoria_nova ?? "—"}`,
              formatWhen(r.em),
            ],
          }))}
        />
      ) : null}
    </div>
  );
}

function CategoryChips({ title, items }: { title: string; items: { id: string; label: string; value: number }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-eyebrow text-pale-stone">{title}</h4>
      <ul aria-label={title} className="m-0 flex list-none flex-wrap gap-2 p-0">
        {items.map((item) => (
          <li key={item.id} className="rounded-buttons border border-carbon-lift px-2 py-1 text-body-sm text-bone">
            {item.label}: <span className="tabular-nums">{formatCount(item.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// status (sincronização)
// ---------------------------------------------------------------------------

function Facts({ title, facts }: { title: string; facts: [string, string][] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-eyebrow text-pale-stone">{title}</h4>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2">
        {facts.map(([term, value]) => (
          <div key={term} className="flex min-w-0 flex-col">
            <dt className="text-caption text-warm-granite">{term}</dt>
            <dd className="m-0 break-words text-body-sm tabular-nums text-bone">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SyncView({ dados }: { dados: SyncStatusData }) {
  const imp = dados.ultima_importacao;
  const job = dados.ultimo_job;
  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-xs">
        <StatCard
          stat={{ id: "sync-conflitos", label: "Divergências pendentes", value: dados.conflitos_pendentes }}
          className="rounded-cards p-3 sm:p-4"
        />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {imp ? (
          <Facts
            title="Última importação confirmada"
            facts={[
              ["Confirmada em", formatWhen(imp.confirmada_em)],
              ["Linhas", formatCount(imp.linhas)],
              ["Novos", formatCount(imp.novos)],
              ["Existentes", formatCount(imp.existentes)],
              ["Duplicados", formatCount(imp.duplicados)],
              ["Inválidos", formatCount(imp.invalidos)],
              ["Conflitantes", formatCount(imp.conflitantes)],
            ]}
          />
        ) : (
          <Note>Nenhuma importação confirmada até agora.</Note>
        )}
        {job ? (
          <Facts
            title="Última sincronização"
            facts={[
              ["Situação", jobStatusLabel(job.status)],
              ["Iniciada em", formatWhen(job.iniciado_em)],
              ["Finalizada em", formatWhen(job.finalizado_em)],
              ["Lidos", formatCount(job.lidos)],
              ["Criados", formatCount(job.criados)],
              ["Atualizados", formatCount(job.atualizados)],
              ["Falhas", formatCount(job.falhas)],
            ]}
          />
        ) : (
          <Note>Nenhuma sincronização registrada até agora.</Note>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vazio e despacho
// ---------------------------------------------------------------------------

/** Vazio honesto por tipo: `status` nunca é vazio (mostra o que existir). */
export function isPanelEmpty(data: PanelData): boolean {
  switch (data.tipo) {
    case "cartoes":
    case "tabela":
    case "grafico":
      return data.dados.total === 0;
    case "distribuicao":
      return data.dados.total === 0;
    case "ranking":
      return data.dados.notebooks === 0 && data.dados.docking === 0;
    case "razao":
      return data.dados.computadores === 0 && data.dados.notebooks === 0 && data.dados.monitores === 0;
    case "fila":
      return false;
    case "lista":
      return data.dados.total === 0 && data.dados.recentes.length === 0;
    case "status":
      return false;
  }
}

export function PanelView({ data, label }: { data: PanelData; label: string }) {
  switch (data.tipo) {
    case "cartoes":
      return <CardsView dados={data.dados} label={label} />;
    case "tabela":
      return <TableView dados={data.dados} label={label} />;
    case "grafico":
      return <ChartView dados={data.dados} label={label} />;
    case "distribuicao":
      return <DistributionView dados={data.dados} />;
    case "ranking":
      return <RankingView dados={data.dados} label={label} />;
    case "razao":
      return <RatioView dados={data.dados} label={label} />;
    case "fila":
      return <QueueView dados={data.dados} label={label} />;
    case "lista":
      return <OverridesView dados={data.dados} label={label} />;
    case "status":
      return <SyncView dados={data.dados} />;
  }
}
