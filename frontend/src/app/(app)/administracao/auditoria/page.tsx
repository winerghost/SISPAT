import { Suspense } from "react";

import { AuditView } from "@/components/features/audit/audit-view";
import { CatalogHeader } from "@/components/features/catalog/catalog-parts";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

// =============================================================================
// /administracao/auditoria — consulta SOMENTE LEITURA da trilha de auditoria
// (ADM + AAL2 + audit.read). Escopo de unidade e projeção sem segredos são do
// backend. Filtros/página/registro aberto na URL; a parte que lê a URL fica em
// <Suspense> (useSearchParams). Ocultar o menu para USER/RH é só UX.
// =============================================================================

export default function AuditoriaPage() {
  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Administração"
        title="Auditoria"
        description="Consulta da trilha de auditoria das unidades do seu escopo. Somente leitura: os registros não podem ser alterados nem apagados, e dados pessoais e segredos nunca são exibidos."
      />
      <Suspense fallback={<LoadingSkeleton variant="table" count={5} columns={6} label="Carregando auditoria…" />}>
        <AuditView />
      </Suspense>
    </div>
  );
}
