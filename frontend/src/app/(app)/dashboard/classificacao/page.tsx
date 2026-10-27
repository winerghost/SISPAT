import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ClassificationReview } from "@/components/features/dashboard/classification-review";

// =============================================================================
// /dashboard/classificacao: fila de revisão (bens "Outros" com confiança baixa).
// Só o ADM com MFA concluído recebe dados; quem não tem acesso vê uma mensagem
// neutra. A decisão é do backend (o link do painel é apenas conveniência).
// =============================================================================

export default function ClassificationReviewPage() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-3">
        <Link
          href="/dashboard"
          className="inline-flex w-fit items-center gap-2 rounded-buttons text-body-sm text-warm-granite transition-factory hover:text-chalk focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Voltar ao dashboard
        </Link>
        <div className="flex items-center gap-3">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-orange" aria-hidden />
          <span className="text-eyebrow text-pale-stone">Classificação patrimonial</span>
        </div>
        <h1 className="text-heading text-bone">Fila de revisão</h1>
        <p className="max-w-page text-body text-warm-granite">
          Bens que a regra automática não conseguiu classificar. Corrija a categoria; a mudança só vale depois da confirmação do servidor.
        </p>
      </header>
      <ClassificationReview />
    </div>
  );
}
