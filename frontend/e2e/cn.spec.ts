import { expect, test } from "@playwright/test";

import { cn } from "../src/lib/utils";

// Unitário do `cn`: a escala tipográfica do DESIGN.md e os tokens customizados
// não podem ser descartados quando coexistem com utilitários de cor.
test.describe("cn (tailwind-merge com tokens do DESIGN.md)", () => {
  for (const size of ["caption", "body-sm", "body", "heading", "heading-lg", "display", "eyebrow"]) {
    test(`text-${size} coexiste com cor text-*`, () => {
      const out = cn(`text-${size}`, "text-bone").split(" ");
      expect(out).toContain(`text-${size}`);
      expect(out).toContain("text-bone");
      const out2 = cn("text-pale-stone", `text-${size}`).split(" ");
      expect(out2).toEqual(["text-pale-stone", `text-${size}`]);
    });
  }

  test("tamanhos conflitantes: o último vence", () => {
    expect(cn("text-body", "text-heading")).toBe("text-heading");
    expect(cn("text-sm", "text-heading-lg")).toBe("text-heading-lg");
    expect(cn("text-heading", "text-xl")).toBe("text-xl");
  });

  test("cores conflitantes: o último vence", () => {
    expect(cn("text-bone", "text-signal-orange")).toBe("text-signal-orange");
    expect(cn("text-heading text-bone", "text-chalk")).toBe("text-heading text-chalk");
  });

  test("raios, sombra, espaçamento e peso customizados", () => {
    expect(cn("rounded-cards", "rounded-panel")).toBe("rounded-panel");
    expect(cn("rounded-lg", "rounded-nav")).toBe("rounded-nav");
    expect(cn("p-4", "p-card-padding")).toBe("p-card-padding");
    expect(cn("gap-2", "gap-element-gap")).toBe("gap-element-gap");
    expect(cn("shadow-sm", "shadow-hairline")).toBe("shadow-hairline");
    expect(cn("font-medium", "font-regular")).toBe("font-regular");
    expect(cn("font-mono font-regular")).toBe("font-mono font-regular");
  });

  test("clsx condicional e utilitários não relacionados são preservados", () => {
    expect(cn("flex", false && "hidden", { "gap-2": true, "gap-4": false }, ["px-2"])).toBe(
      "flex gap-2 px-2",
    );
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
