"use client";

import { Suspense } from "react";

import { PatrimoniosPage } from "@/components/features/assets/patrimonios-page";

// useSearchParams (busca global `?busca=`) exige <Suspense>.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PatrimoniosPage />
    </Suspense>
  );
}
