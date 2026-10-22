"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Download } from "lucide-react";

import { chartClasses } from "@/components/dashboard/chart-theme";
import type { DashboardStat } from "@/components/dashboard/types";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ApiError } from "@/lib/api-client";
import { downloadTechExport, type TechExportFormat } from "@/lib/dashboard-export";
import {
  useTechByStatus,
  useTechByUnit,
  useTechCategories,
  useTechRegistrationAge,
  useTechSummary,
  useTechWithoutOwner,
  type DashboardFilters,
  type TechSummary,
  type TechWithoutOwner,
} from "@/lib/dashboard-api";
import { cn } from "@/lib/utils";

import { Block, CountCards, chartPlaceholder, formatInt, type PanelCtx } from "./dashboard-block";
import { buildRoomData, buildUnitModel } from "./dashboard-transform";

// =============================================================================
// Painéis de TECNOLOGIA do dashboard (ids tech_*). Só apresentação:
// - todo número vem de `/api/v1/dashboard/tecnologia/*`; nada é estimado,
//   somado ou preenchido no cliente (inclusive o percentual de "sem responsável");
// - valores ausentes aparecem como "não informado"/"não classificado" (rótulos
//   do backend), nunca como um valor padrão inventado;
// - cada gráfico usa a casca `chart-shell` (resumo em texto + tabela sr-only);
// - "tempo desde o registro" é a data de CADASTRO do bem no sistema, não a
//   idade do equipamento (não existe data de aquisição nem garantia no cadastro);
// - só contagens: nenhum dado pessoal, nem para o perfil RH;
// - números não animam sem confirmação: StatCard só recebe valor já retornado.
// =============================================================================

const HorizontalBar = dynamic(
  () => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedHorizontalBarChart),
  { ssr: false, loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" /> },
);
const StackedBar = dynamic(
  () => import("@/components/dashboard/nivo-bar-charts").then((m) => m.AnimatedStackedBarChart),
  { ssr: false, loading: () => <LoadingSkeleton variant="cards" count={1} label="Carregando gráfico" /> },
);

const NOT_INFORMED_NOTE =
  "Itens sem classificação ou sem situação informada aparecem como “não classificado” ou “não informado”: nenhum valor é presumido.";

// ---------------------------------------------------------------------------
// Indicadores + exportação
// ---------------------------------------------------------------------------

function techStats(data: TechSummary): DashboardStat[] {
  return [
    { id: "tec-total", label: "Bens no filtro", value: data.total_bens },
    { id: "tec-tecnologia", label: "Bens de tecnologia", value: data.tecnologia },
    { id: "tec-nao-classificados", label: "Não classificados", value: data.nao_classificados },
    { id: "tec-sem-responsavel", label: "TI sem responsável", value: data.tecnologia_sem_responsavel },
    { id: "tec-sem-tipo", label: "TI sem tipo informado", value: data.tecnologia_sem_tipo },
    { id: "tec-sem-status", label: "TI sem situação informada", value: data.tecnologia_sem_status },
  ];
}

export function exportErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Seu perfil não tem permissão para exportar.";
    if (error.status === 429) return "Muitas exportações em pouco tempo. Aguarde e tente novamente.";
    if (error.status === 413) return "A exportação excede o limite de linhas. Refine os filtros.";
  }
  return "Não foi possível gerar o arquivo. Tente novamente.";
}

function TechExportActions({ filters }: { filters: DashboardFilters }) {
  const [busy, setBusy] = useState<TechExportFormat | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const run = async (format: TechExportFormat) => {
    setBusy(format);
    setMessage(null);
    try {
      const name = await downloadTechExport(format, filters);
      setMessage({ kind: "ok", text: `Arquivo ${name} gerado.` });
    } catch (error) {
      setMessage({ kind: "error", text: exportErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5 print:hidden" data-tech-export>
      <div className="flex flex-wrap items-center gap-2">
        {(["csv", "xlsx"] as const).map((format) => (
          <Button
            key={format}
            variant="ghost"
            size="sm"
            loading={busy === format}
            disabled={busy !== null}
            onClick={() => void run(format)}
          >
            <Download aria-hidden />
            {`Exportar ${format.toUpperCase()}`}
          </Button>
        ))}
        <span className="text-caption text-warm-granite">Tabela agregada, sem dados pessoais.</span>
      </div>
      <p role={message?.kind === "error" ? "alert" : "status"} className="min-h-[1lh] text-body-sm text-bone">
        {message?.text ?? ""}
      </p>
    </div>
  );
}

export function TechSummaryBlock({ theme, filters, wide }: PanelCtx) {
  const query = useTechSummary(filters);
  return (
    <Block
      id="tecnologia-indicadores"
      title="Tecnologia: indicadores"
      query={query}
      theme={theme}
      isEmpty={() => false}
      emptyTitle=""
      emptyDescription=""
      skeleton={<LoadingSkeleton variant="cards" count={6} label="Carregando indicadores de tecnologia" />}
      wide={wide}
    >
      {(data) => (
        <>
          <CountCards label="Indicadores de tecnologia" stats={techStats(data)} theme={theme} />
          <p className={cn("px-4 pb-4 text-body-sm sm:px-5", chartClasses(theme).legendValue)}>{NOT_INFORMED_NOTE}</p>
          {theme === "screen" ? <TechExportActions filters={filters} /> : null}
        </>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Categoria / tipo de TI
// ---------------------------------------------------------------------------

export function TechCategoryBlock({ theme, filters, filtered, wide }: PanelCtx) {
  const query = useTechCategories(filters);
  return (
    <Block
      id="tecnologia-categoria"
      title="Tecnologia: bens por categoria"
      query={query}
      theme={theme}
      isEmpty={(data) => data.categorias.length === 0}
      emptyTitle="Nenhum bem para classificar"
      emptyDescription="Não há bens nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando bens por categoria")}
      wide={wide}
      filtered={filtered}
    >
      {(data) => (
        <>
          <HorizontalBar
            title="Quantidade de bens por categoria"
            description="Categoria do bem; sem categoria aparece como “Não classificado”."
            data={buildRoomData(data.categorias)}
            valueFormatter={formatInt}
            theme={theme}
            className="border-0 p-4 sm:p-5"
          />
          {data.tipos_ti.length > 0 ? (
            <HorizontalBar
              title="Quantidade de bens de tecnologia por tipo"
              description="Só bens da categoria Tecnologia."
              data={buildRoomData(data.tipos_ti)}
              valueFormatter={formatInt}
              theme={theme}
              className="border-0 p-4 pt-0 sm:p-5 sm:pt-0"
            />
          ) : null}
        </>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Por unidade
// ---------------------------------------------------------------------------

export function TechUnitsBlock({ theme, filters, filtered, wide }: PanelCtx) {
  const query = useTechByUnit(filters);
  const model = useMemo(() => (query.data ? buildUnitModel(query.data, (tipo) => tipo) : undefined), [query.data]);
  return (
    <Block
      id="tecnologia-por-unidade"
      title="Tecnologia por unidade"
      query={query}
      theme={theme}
      isEmpty={(rows) => rows.length === 0}
      emptyTitle="Nenhum bem de tecnologia"
      emptyDescription="Não há bens classificados como tecnologia nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando tecnologia por unidade")}
      wide={wide}
      filtered={filtered}
    >
      {() =>
        model && (
          <StackedBar
            title="Bens de tecnologia por tipo em cada unidade"
            description="Unidade de uso do bem; até 15 unidades, o restante somado em “Outras”."
            data={model.chart}
            valueFormatter={formatInt}
            theme={theme}
            className="border-0 p-4 sm:p-5"
          />
        )
      }
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Situação operacional
// ---------------------------------------------------------------------------

export function TechStatusBlock({ theme, filters, filtered, wide }: PanelCtx) {
  const query = useTechByStatus(filters);
  return (
    <Block
      id="tecnologia-situacao"
      title="Tecnologia por situação operacional"
      query={query}
      theme={theme}
      isEmpty={(items) => items.length === 0}
      emptyTitle="Nenhum bem de tecnologia"
      emptyDescription="Não há bens classificados como tecnologia nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando situação operacional")}
      wide={wide}
      filtered={filtered}
    >
      {(items) => (
        <HorizontalBar
          title="Bens de tecnologia por situação operacional"
          description="Situação ainda não informada no cadastro aparece como “Não informado”."
          data={buildRoomData(items)}
          valueFormatter={formatInt}
          theme={theme}
          className="border-0 p-4 sm:p-5"
        />
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Sem responsável (só contagens)
// ---------------------------------------------------------------------------

const percentFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

function noOwnerStats(data: TechWithoutOwner): DashboardStat[] {
  return [
    { id: "sr-tecnologia", label: "Bens de tecnologia", value: data.tecnologia },
    { id: "sr-sem-responsavel", label: "Sem responsável", value: data.sem_responsavel },
    {
      id: "sr-percentual",
      label: "Parcela sem responsável",
      value: data.percentual,
      decimals: 1,
      unit: "%",
      description: data.percentual === null ? undefined : `${percentFormat.format(data.percentual)}% dos bens de tecnologia`,
    },
  ];
}

export function TechNoOwnerBlock({ theme, filters, filtered, wide }: PanelCtx) {
  const query = useTechWithoutOwner(filters);
  return (
    <Block
      id="tecnologia-sem-responsavel"
      title="Tecnologia sem responsável"
      query={query}
      theme={theme}
      isEmpty={(data) => data.tecnologia === 0}
      emptyTitle="Nenhum bem de tecnologia"
      emptyDescription="Não há bens classificados como tecnologia nas unidades visíveis para o seu perfil."
      skeleton={<LoadingSkeleton variant="cards" count={3} label="Carregando tecnologia sem responsável" />}
      wide={wide}
      filtered={filtered}
    >
      {(data) => (
        <>
          <CountCards label="Tecnologia sem responsável" stats={noOwnerStats(data)} theme={theme} />
          {data.por_unidade.length > 0 ? (
            <HorizontalBar
              title="Bens de tecnologia sem responsável por unidade"
              description="Somente contagens; nenhuma pessoa é exibida."
              data={buildRoomData(
                data.por_unidade.map((row, i) => ({ id: `u${i}`, label: row.unidade, value: row.value })),
              )}
              valueFormatter={formatInt}
              theme={theme}
              className="border-0 p-4 pt-0 sm:p-5 sm:pt-0"
            />
          ) : null}
        </>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Tempo desde o registro
// ---------------------------------------------------------------------------

export function TechAgeBlock({ theme, filters, filtered, wide }: PanelCtx) {
  const query = useTechRegistrationAge(filters);
  return (
    <Block
      id="tecnologia-tempo-registro"
      title="Tecnologia: tempo desde o registro"
      query={query}
      theme={theme}
      isEmpty={(items) => items.length === 0}
      emptyTitle="Nenhum bem de tecnologia"
      emptyDescription="Não há bens classificados como tecnologia nas unidades visíveis para o seu perfil."
      skeleton={chartPlaceholder("Carregando tempo desde o registro")}
      wide={wide}
      filtered={filtered}
    >
      {(items) => (
        <>
          <HorizontalBar
            title="Bens de tecnologia por tempo desde o registro"
            description="Tempo desde a data de registro do bem no sistema; não é a idade do equipamento."
            data={buildRoomData(items)}
            valueFormatter={formatInt}
            theme={theme}
            className="border-0 p-4 sm:p-5"
          />
          <p className={cn("px-4 pb-4 text-body-sm sm:px-5", chartClasses(theme).legendValue)}>
            Não há data de aquisição nem de garantia no cadastro: nenhum prazo de garantia é calculado.
          </p>
        </>
      )}
    </Block>
  );
}
