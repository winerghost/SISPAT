"use client";

import { ReportsView } from "@/components/features/reports/reports-view";

// =============================================================================
// /relatorios — relatórios e exportações CSV/XLSX sobre `GET /api/v1/reports`.
// Todos os perfis autenticados; o backend decide perfil, escopo de unidade e
// campos (RH sem texto livre) e audita cada exportação.
// =============================================================================

export default function RelatoriosPage() {
  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Patrimônio</span>
        <h1 className="text-heading text-bone">Relatórios</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Exporte patrimônios, movimentações e itens de inventário em CSV ou XLSX, respeitando as unidades do seu acesso.
        </p>
      </div>
      <ReportsView />
    </div>
  );
}
