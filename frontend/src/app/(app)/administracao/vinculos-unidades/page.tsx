"use client";

import { Suspense } from "react";

import { CatalogHeader } from "@/components/features/catalog/catalog-parts";
import { UnitAccessManageLink, UnitAccessView } from "@/components/features/admin-access/unit-access-view";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

// =============================================================================
// /administracao/vinculos-unidades — vínculos usuário x unidades (ADM), SOMENTE
// LEITURA. Fonte: `GET /api/v1/admin/unit-access`. Para alterar perfil/unidades
// use a tela Usuários. As partes que leem a URL ficam em <Suspense>.
// =============================================================================

export default function VinculosUnidadesPage() {
  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <CatalogHeader
        eyebrow="Administração"
        title="Vínculos de Unidades"
        description="Consulta de quais unidades do seu escopo cada usuário acessa, com filtros por unidade, perfil e situação. Somente leitura."
        action={<UnitAccessManageLink />}
      />
      <Suspense fallback={<LoadingSkeleton variant="table" count={5} columns={4} label="Carregando vínculos…" />}>
        <UnitAccessView />
      </Suspense>
    </div>
  );
}
