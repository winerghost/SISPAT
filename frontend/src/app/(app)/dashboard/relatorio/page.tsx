"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";

import { useFilterLabels } from "@/components/features/dashboard/dashboard-filter-labels";
import { DashboardPanels } from "@/components/features/dashboard/dashboard-panels";
import {
  hrefWithFilters,
  useAppliedDashboardFilters,
} from "@/components/features/dashboard/use-dashboard-url-filters";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import type { DashboardFilters } from "@/lib/dashboard-api";

// =============================================================================
// /dashboard/relatorio — mesma composição do dashboard em formato de relatório:
// folha clara (Light Surface Card, texto escuro) para leitura em papel/PDF.
// Herda os filtros da URL (mesmo parse defensivo do dashboard) e os lista no
// cabeçalho com rótulos humanos ("Vínculo: Ocioso").
// Impressão: sem sidebar/header (print:hidden no shell), sem rolagem interna,
// quebras de página evitadas dentro de cada bloco e cores legíveis em papel
// (tema "paper" de chart-theme.ts). "Imprimir / Salvar PDF" = window.print().
// =============================================================================

const issuedFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Araguaina",
});

function ReportFilters({ filters }: { filters: DashboardFilters }) {
  const labels = useFilterLabels(filters);
  return (
    <section aria-labelledby="relatorio-filtros" data-report-filters className="flex flex-col gap-1">
      <h2 id="relatorio-filtros" className="text-eyebrow text-graphite-mid">
        Filtros aplicados
      </h2>
      {labels.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-body-sm text-obsidian-canvas">
          {labels.map((label) => (
            <li key={label.key} className="break-words">
              {label.name}: {label.value}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-obsidian-canvas">Nenhum — todos os bens visíveis para o perfil.</p>
      )}
    </section>
  );
}

function ReportContent() {
  const { filters, query } = useAppliedDashboardFilters();
  // Data/hora de EMISSÃO (relógio do navegador), definida após a hidratação.
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  useEffect(() => {
    setIssuedAt(issuedFormatter.format(new Date()));
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8 print:gap-0 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={hrefWithFilters("/dashboard", query)}
          className="inline-flex min-h-6 items-center gap-2 rounded-nav text-body-sm text-pale-stone transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Voltar ao dashboard
        </Link>
        <Button variant="light" onClick={() => window.print()}>
          <Printer aria-hidden />
          Imprimir / Salvar PDF
        </Button>
      </div>

      <article
        data-report-sheet
        className="flex flex-col gap-6 rounded-cards bg-bone p-4 text-obsidian-canvas sm:p-8 print:rounded-none print:bg-white print:p-0 [print-color-adjust:exact]"
      >
        <header className="flex flex-col gap-3 border-b border-graphite-mid/40 pb-4">
          <span className="text-eyebrow text-graphite-mid">SISPAT-AGU · Advocacia-Geral da União · Palmas/TO</span>
          <h1 className="text-heading text-obsidian-canvas">Relatório patrimonial</h1>
          <p className="text-body-sm text-graphite-mid">
            Indicadores das unidades visíveis para o perfil de quem emitiu.
            {issuedAt ? <> Emitido em {issuedAt} (horário de Araguaína).</> : null}
          </p>
          <ReportFilters filters={filters} />
        </header>

        <DashboardPanels theme="paper" filters={filters} />

        <footer className="border-t border-graphite-mid/40 pt-3 text-body-sm text-graphite-mid">
          Valores obtidos do backend no momento da emissão, com os filtros listados no cabeçalho; nenhum número é
          estimado. Indicadores sem base no cadastro atual constam como indisponíveis.
        </footer>
      </article>
    </div>
  );
}

export default function DashboardReportPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="cards" count={4} label="Carregando relatório" />}>
      <ReportContent />
    </Suspense>
  );
}
