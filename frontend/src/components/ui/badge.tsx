import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge — voz "instrumento" do sistema: Geist Mono 12px uppercase, tracking
 * apertado (ver DESIGN.md > "Voice & Type Treatment"). Usado para status
 * tags, contadores e rótulos de estado.
 *
 * Variantes `warning`/`success` são as ÚNICAS que usam signal-orange /
 * metric-green — e só como texto/borda sobre fundo transparente, nunca como
 * fill grande (DESIGN.md > Don't: "não preencher botões/cards com cor de
 * marca").
 */
const badgeVariants = cva(
  // transition-factory: cor/borda trocam juntas em 150 ms (ex.: status que muda).
  // Ícones filhos (lucide) ficam em 12px e herdam a cor — ícone + texto, nunca só cor.
  "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-eyebrow transition-factory [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-ash-stroke text-pale-stone",
        outline: "border-ash-stroke text-bone",
        warning: "border-signal-orange/50 text-signal-orange",
        success: "border-metric-green/50 text-metric-green",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
