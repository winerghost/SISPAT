import Image from "next/image";

import aguLogo from "@/assets/brand/agu-logo.png";

// Logomarca da AGU (ativo de marca, 640x381, PNG transparente).
// Aplicada direto sobre o canvas escuro (#101010), sem painel claro: o bloco
// #eeeeee ao redor "estourava" o branco no tema dark. O azul tem contraste
// baixo sobre o canvas, então um leve `brightness` o clareia sem trocar o tom
// (só filtro: sem sombra/blur, conforme DESIGN.md).
// Centralizada pelo layout público (header em coluna). Dimensões estáticas (import) => sem layout shift. `priority` p/ LCP no login.
export function AguLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex justify-center ${className}`}>
      <Image
        src={aguLogo}
        alt="Logomarca da Advocacia-Geral da União"
        priority
        sizes="(min-width: 640px) 176px, 144px"
        className="h-auto w-36 brightness-125 sm:w-44"
      />
    </div>
  );
}
