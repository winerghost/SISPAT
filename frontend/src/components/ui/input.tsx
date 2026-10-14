import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Input — superfície escura (carbon-lift), borda hairline ash-stroke,
 * raio 3px (mesma família dos botões/nav). Foco troca a borda para bone,
 * sem glow/sombra, em linha com "zero dependência de sombra" do DESIGN.md.
 * Borda muda em 150ms (transition-factory); `aria-invalid` sinaliza erro.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-buttons border border-ash-stroke bg-carbon-lift px-3 py-1 text-body-sm text-bone placeholder:text-warm-granite outline-none transition-factory",
          "hover:border-graphite-mid focus-visible:border-bone disabled:cursor-not-allowed disabled:opacity-50",
          // Erro: aria-invalid troca a borda para signal-orange (status, não
          // decoração) na mesma transição de 150ms; o foco continua bone.
          "aria-[invalid=true]:border-signal-orange aria-[invalid=true]:focus-visible:border-bone",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
