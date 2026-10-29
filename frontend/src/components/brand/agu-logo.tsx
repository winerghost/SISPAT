import Image from "next/image";

import aguLogo from "@/assets/brand/halloween-agu.png";

// Logomarca da AGU no cabeçalho público (sazonal de Halloween, 640x533, PNG sem alfa).
// Aplicada direto sobre o canvas escuro (#101010), sem painel claro: o bloco
// #eeeeee ao redor "estourava" o branco no tema dark.
// O PNG não tem canal alfa e o fundo é preto puro, então `mix-blend-screen` faz o
// preto desaparecer por completo sobre o canvas (não é sombra/blur/glow nosso,
// conforme DESIGN.md). Dimensionada por ALTURA (86px / 105px) para manter
// exatamente a mesma altura de cabeçalho da logomarca oficial, sem layout shift.
// Centralizada pelo layout público (header em coluna). Dimensões estáticas (import) => sem layout shift. `priority` p/ LCP no login.
//
// TEMPORÁRIO — Halloween
// Troca sazonal. O ativo oficial continua em `@/assets/brand/agu-logo.png`
// (intacto; `/og` segue usando ele). Para reverter:
//   1. voltar o import para "@/assets/brand/agu-logo.png";
//   2. devolver `brightness-125` (o azul da AGU tem contraste baixo em #101010);
//   3. remover `mix-blend-screen` (o ativo oficial já é transparente);
//   4. voltar as classes de tamanho para `h-auto w-36 sm:w-44` e o
//      `sizes="(min-width: 640px) 176px, 144px"`.
export function AguLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex justify-center ${className}`}>
      <Image
        src={aguLogo}
        alt="Logomarca da Advocacia-Geral da União"
        priority
        sizes="(min-width: 640px) 126px, 103px"
        className="h-[86px] w-auto mix-blend-screen sm:h-[105px]"
      />
    </div>
  );
}
