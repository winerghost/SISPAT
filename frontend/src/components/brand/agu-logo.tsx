import Image from "next/image";

import aguLogo from "@/assets/brand/agu-logo.png";

// Logomarca da AGU (ativo de marca, 640x381, PNG transparente, sem recolorir).
// DESIGN.md: o azul da logo tem baixo contraste sobre #101010; por isso fica
// sobre um "Light Surface Card" (#eeeeee, raio 10px, padding 24px, sem sombra).
// Centralizada pelo layout público (header em coluna). Dimensões estáticas (import) => sem layout shift. `priority` p/ LCP no login.
export function AguLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex justify-center rounded-cards bg-bone p-card-padding ${className}`}>
      <Image
        src={aguLogo}
        alt="Logomarca da Advocacia-Geral da União"
        priority
        sizes="(min-width: 640px) 176px, 144px"
        className="h-auto w-36 sm:w-44"
      />
    </div>
  );
}
