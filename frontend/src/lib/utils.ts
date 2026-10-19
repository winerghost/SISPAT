import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Escala tipográfica do DESIGN.md (tailwind.config.ts > fontSize) + a voz
 * "instrumento" `text-eyebrow` (classe de componente em globals.css). Sem
 * declará-los, o tailwind-merge os trata como COR e descarta o tamanho quando
 * há outra `text-*` de cor na mesma lista (ex.: `text-heading text-bone`).
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      "font-weight": ["regular"],
      shadow: ["hairline"],
      radius: ["nav", "buttons", "cards", "panel"],
      spacing: ["section-gap", "card-padding", "element-gap"],
    },
    classGroups: {
      "font-size": [
        {
          text: ["caption", "body-sm", "body", "heading", "heading-lg", "display", "eyebrow"],
        },
      ],
    },
  },
});

/**
 * Combina classes condicionais (clsx) e resolve conflitos de utilitários
 * Tailwind (tailwind-merge) conhecendo os tokens customizados do DESIGN.md.
 * Usado por todos os componentes em `src/components/ui/`, no padrão shadcn/ui.
 */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
