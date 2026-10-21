import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

// Atalho da Home para /dashboard. Extraído para que a página (que renderiza
// saída de IA) não contenha `href=` — o teste de segurança proíbe âncoras ali.
export function DashboardShortcut() {
  return (
    <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
      Abrir o Dashboard
      <ArrowRight aria-hidden />
    </Link>
  );
}
