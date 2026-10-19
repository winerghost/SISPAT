"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";

import { DashboardPanels } from "@/components/features/dashboard/dashboard-panels";
import { Button } from "@/components/ui/button";

// =============================================================================
// /dashboard/relatorio — mesma composição do dashboard em formato de relatório:
// folha clara (Light Surface Card, texto escuro) para leitura em papel/PDF.
// Impressão: sem sidebar/header (print:hidden no shell), sem rolagem interna,
// quebras de página evitadas dentro de cada bloco e cores legíveis em papel
// (tema "paper" de chart-theme.ts). "Imprimir / Salvar PDF" = window.print().
// =============================================================================

const issuedFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Araguaina",
});

export default function DashboardReportPage() {
  // Data/hora de EMISSÃO (relógio do navegador), definida após a hidratação.
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  useEffect(() => {
    setIssuedAt(issuedFormatter.format(new Date()));
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8 print:gap-0 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/dashboard"
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
        <header className="flex flex-col gap-2 border-b border-graphite-mid/40 pb-4">
          <span className="text-eyebrow text-graphite-mid">SISPAT-AGU · Advocacia-Geral da União · Palmas/TO</span>
          <h1 className="text-heading text-obsidian-canvas">Relatório patrimonial</h1>
          <p className="text-body-sm text-graphite-mid">
            Indicadores das unidades visíveis para o perfil de quem emitiu.
            {issuedAt ? <> Emitido em {issuedAt} (horário de Araguaína).</> : null}
          </p>
        </header>

        <DashboardPanels theme="paper" />

        <footer className="border-t border-graphite-mid/40 pt-3 text-body-sm text-graphite-mid">
          Valores obtidos do backend no momento da emissão; nenhum número é estimado. Indicadores sem base no
          cadastro atual constam como indisponíveis.
        </footer>
      </article>
    </div>
  );
}
