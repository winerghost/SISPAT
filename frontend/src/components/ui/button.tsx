import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

// =============================================================================
// Button — padrão shadcn/ui (Radix Slot + cva), temizado conforme DESIGN.md.
// =============================================================================
// Mapeamento de variantes → componentes do DESIGN.md:
//  - default  → "Dark Filled Button" (#1f1d1c bg, #eeeeee texto, raio 3px)
//  - light    → "Light Filled Button" (#fafafa bg, #101010 texto) — alta
//               ênfase; usar com moderação (ex.: login, CTA principal).
//  - ghost    → "Ghost Text Link" (transparente, borda 1px #3d3a39)
//  - outline  → variação de ghost com borda sempre visível
//  - destructive → única variante que introduz cor fora da paleta neutra,
//               reservada para ações irreversíveis (ex.: excluir); usa
//               signal-orange apenas na borda/texto, nunca como fill grande,
//               em linha com "Do's and Don'ts > Don't" do DESIGN.md.
//  - outlineOnLight → outline para uso sobre superfícies claras (diálogos)
//  - link     → texto puro, sem padding, sublinhado no hover
// Todos os botões usam raio 3px (--radius-buttons) e padding horizontal
// 14px, Geist 14px peso 400 — nenhuma variante usa bold ou sombra.
// Motion: cores/borda trocam juntas em 150ms (transition-factory-press) e o
// press tem feedback discreto (scale 0.98), desligado sob reduced motion.
// `loading` desabilita o botão, marca aria-busy e mostra spinner (aria-hidden)
// mantendo o rótulo visível — o nome acessível não muda.
// =============================================================================

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-buttons text-body-sm font-regular transition-factory-press active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-2 focus-visible:ring-offset-obsidian-canvas disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-carbon-lift text-bone hover:bg-[#262320]",
        light: "bg-chalk text-obsidian-canvas hover:bg-bone",
        ghost:
          "bg-transparent text-bone border border-ash-stroke hover:border-chalk hover:text-chalk",
        outline: "bg-transparent text-bone border border-ash-stroke hover:bg-carbon-lift",
        // Para superfícies claras (Light Surface Card / Dialog bg-bone): texto
        // obsidian (16.9:1) e borda graphite-mid. `outline`/`destructive`
        // padrão têm texto claro/laranja e ficam ilegíveis sobre bone
        // (bone/bone ~1:1; signal-orange/bone 2.9:1 < 4.5:1 WCAG 1.4.3).
        outlineOnLight:
          "bg-transparent text-obsidian-canvas border border-graphite-mid hover:bg-obsidian-canvas/5",
        destructive:
          "bg-transparent text-signal-orange border border-signal-orange/40 hover:bg-signal-orange/10",
        link: "bg-transparent text-bone underline-offset-4 hover:underline p-0 h-auto active:scale-100",
      },
      size: {
        default: "h-9 px-[14px]",
        sm: "h-8 px-3 text-caption",
        lg: "h-11 px-6",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Estado de carregamento: desabilita, aria-busy e spinner acessível. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    if (asChild) {
      // Slot exige filho único: sem spinner; repassa só o estado semântico.
      return (
        <Slot className={classes} ref={ref} aria-busy={loading || undefined} {...props}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin-slow" aria-hidden="true" /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
