"use client";

import { ModulePage } from "@/components/features/modules/module-page";

// Módulo ainda sem backend: painel honesto (ver features/modules/module-catalog.ts).
export default function Page() {
  return <ModulePage module="auditoria" />;
}
