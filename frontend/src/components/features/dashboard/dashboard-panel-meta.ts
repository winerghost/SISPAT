// =============================================================================
// Metadados dos painéis personalizáveis do dashboard (ids = contrato
// `dashboard_layout` do backend) e regra de largura na grade de 2 colunas.
// Só apresentação: quais painéis existem e o que cada perfil vê no número é
// decidido pelo backend.
// =============================================================================

import type { DashboardLayout, DashboardPanelId } from "@/lib/preferences-api";

export interface DashboardPanelMeta {
  /** Título visível do painel (mesmo do cabeçalho do bloco). */
  title: string;
  /** `data-dashboard-block` do bloco (seletor estável de testes). */
  blockId: string;
  /** Ocupa as 2 colunas (gráficos largos, KPIs). */
  wide: boolean;
}

export const DASHBOARD_PANEL_META: Record<DashboardPanelId, DashboardPanelMeta> = {
  kpis: { title: "Indicadores", blockId: "indicadores", wide: true },
  units: { title: "Bens por unidade", blockId: "por-unidade", wide: true },
  status: { title: "Bens por situação", blockId: "por-situacao", wide: false },
  monthly: { title: "Aquisições mensais", blockId: "aquisicoes-mensais", wide: false },
  location: { title: "Localizados × não localizados por unidade", blockId: "localizacao-por-unidade", wide: true },
  bond: { title: "Bens por vínculo", blockId: "por-vinculo", wide: false },
  pending: { title: "Pendências de cadastro", blockId: "pendencias-cadastro", wide: false },
  rooms: { title: "Bens por sala", blockId: "por-sala", wide: false },
  inventory: { title: "Inventário", blockId: "inventario", wide: false },
};

/** Painéis exibidos, na ordem escolhida (sem os ocultos). */
export function visiblePanels(layout: DashboardLayout): DashboardPanelId[] {
  const hidden = new Set(layout.hidden);
  return layout.order.filter((id) => !hidden.has(id));
}

/**
 * Largura efetiva de cada painel, SEM reordenar (a ordem do DOM é a ordem
 * escolhida — leitura e foco seguem a tela). Painel de meia largura que
 * ficaria sozinho na linha (seguido de um largo ou no fim) ocupa as 2 colunas,
 * para a grade não ter buracos.
 */
export function panelSpans(ids: readonly DashboardPanelId[]): Record<string, boolean> {
  const wide: Record<string, boolean> = {};
  let pending: DashboardPanelId | null = null;
  for (const id of ids) {
    if (DASHBOARD_PANEL_META[id].wide) {
      if (pending) wide[pending] = true;
      pending = null;
      wide[id] = true;
    } else if (pending) {
      wide[pending] = false;
      wide[id] = false;
      pending = null;
    } else {
      pending = id;
    }
  }
  if (pending) wide[pending] = true;
  return wide;
}
