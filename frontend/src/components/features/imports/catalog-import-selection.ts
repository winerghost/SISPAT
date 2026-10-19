import type { ImportItemClassification } from "@/lib/imports-api";

// =============================================================================
// Modelo de seleção da importação de cadastros (apresentação). A API não tem
// "selecionar item"; o cliente decide quais `item_ids` enviar na confirmação.
// A seleção é: uma BASE (padrão sugerido pelo backend / todos os elegíveis /
// nenhum) + exceções por item (`overrides`). Só NOVO e EXISTENTE são elegíveis;
// o backend revalida e conta os demais como ignorados. Fica só em memória.
// =============================================================================

export type SelectionBase = "backend" | "all" | "none";

export interface CatalogSelection {
  base: SelectionBase;
  overrides: Record<string, boolean>;
}

export const DEFAULT_SELECTION: CatalogSelection = { base: "backend", overrides: {} };

/**
 * Opt-in de sigla de atalho por item (id → true). Vazio por padrão: nenhum alias
 * é criado sem marcação explícita do ADM (SEC-CAT-04). Só em memória.
 */
export type AliasOptIn = Record<string, boolean>;

export const NO_ALIAS_OPT_IN: AliasOptIn = {};

export function isEligible(classification: ImportItemClassification): boolean {
  return classification === "NOVO" || classification === "EXISTENTE";
}

interface SelectableItem {
  id: string;
  classification: ImportItemClassification;
  selected: boolean;
}

export function isItemSelected(item: SelectableItem, selection: CatalogSelection): boolean {
  if (!isEligible(item.classification)) return false;
  const override = selection.overrides[item.id];
  if (override !== undefined) return override;
  if (selection.base === "all") return true;
  if (selection.base === "none") return false;
  return item.selected;
}

export function toggleItem(item: SelectableItem, selection: CatalogSelection): CatalogSelection {
  if (!isEligible(item.classification)) return selection;
  return {
    ...selection,
    overrides: { ...selection.overrides, [item.id]: !isItemSelected(item, selection) },
  };
}

export function ineligibleReason(classification: ImportItemClassification, errors: string[]): string {
  switch (classification) {
    case "DUPLICADO":
      return "Registro duplicado na planilha de origem — não pode ser selecionado.";
    case "INVALIDO":
      return errors.length > 0
        ? `Registro inválido: ${errors.join("; ")}`
        : "Registro inválido — corrija a planilha de origem antes de importar.";
    case "CONFLITANTE":
      return "Conflito com um registro existente — requer revisão manual antes de importar.";
    default:
      return "";
  }
}
