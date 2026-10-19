"use client";

import { useState } from "react";
import Link from "next/link";

import { Tabs, type TabItem } from "@/components/ui/tabs";
import { CatalogImportPanel } from "@/components/features/imports/catalog-import-panel";
import { CATALOG_KIND_LABEL } from "@/components/features/imports/catalog-import-labels";
import { CATALOG_IMPORT_KINDS, type CatalogImportKind } from "@/lib/catalog-imports-api";

// =============================================================================
// Administração → Importação de Dados → Cadastros de apoio
// =============================================================================
// Importa unidades, salas e pessoas responsáveis da planilha (Google Sheets,
// entrada NÃO confiável): prévia → revisão (resumo, relatório, itens) →
// confirmação em massa. Apenas ADM com MFA (AAL2) e a permissão do tipo; o
// backend decide e nega com mensagens genéricas — esconder o menu é só UX.
// Cada aba é um fluxo independente: trocar de aba descarta a prévia em tela
// (ela continua válida no servidor até expirar, mas é preciso gerar outra).
// Dados pessoais: telefone nunca aparece; e-mail só mascarado; nada é guardado
// em storage nem escrito em console/URL.
// =============================================================================

const TABS: readonly TabItem<CatalogImportKind>[] = CATALOG_IMPORT_KINDS.map((kind) => ({
  id: kind,
  label: CATALOG_KIND_LABEL[kind].tab,
}));

export default function ImportacaoCadastrosPage() {
  const [kind, setKind] = useState<CatalogImportKind>("units");

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Administração / Importação de Dados</span>
        <h1 className="text-heading text-bone">Cadastros de apoio</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Importe unidades, salas e pessoas responsáveis da planilha de origem. Gere a prévia, revise o relatório
          de pendências e confirme apenas os itens corretos. Importe estes cadastros antes dos bens, para que os
          vínculos sejam encontrados.{" "}
          <Link
            href="/administracao/importacao/google-sheets"
            className="text-bone underline underline-offset-4 transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone"
          >
            Ir para a importação de bens
          </Link>
          .
        </p>
      </div>

      <Tabs label="Cadastro a importar" items={TABS} value={kind} onValueChange={setKind}>
        <CatalogImportPanel key={kind} kind={kind} />
      </Tabs>
    </div>
  );
}
