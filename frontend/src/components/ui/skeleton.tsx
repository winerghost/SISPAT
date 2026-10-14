import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Skeleton — placeholder de carregamento sobre carbon-lift (um nível acima
 * do canvas). Shimmer DISCRETO: faixa de 4% de bone em ::after, animada só
 * por transform (globals.css > .skeleton-shimmer); desligado sob
 * prefers-reduced-motion (fica a superfície estática). Decorativo:
 * aria-hidden — o estado "carregando" deve ser anunciado pelo container
 * (ex.: role="status" / aria-busy), ver LoadingSkeleton.
 */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("skeleton-shimmer rounded-sm bg-carbon-lift", className)}
      {...props}
    />
  );
}

export { Skeleton };
