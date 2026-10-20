"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api-client";
import {
  DEFAULT_DASHBOARD_CHARTS,
  updateMyPreferences,
  type DashboardChartPanel,
  type DashboardChartsPrefs,
  type DashboardChartsUpdate,
  type DashboardChartType,
} from "@/lib/preferences-api";
import { persistUiPreferences } from "@/lib/ui-preferences";
import { MY_PREFERENCES_QUERY_KEY, useMyPreferences } from "@/lib/use-my-preferences";

// =============================================================================
// Tipo de gráfico de cada painel do dashboard (preferência do usuário).
// - Fonte de verdade: `GET /api/v1/me/preferences` (`dashboard_charts`).
// - Estado honesto: o gráfico exibido só muda DEPOIS de o PATCH ser confirmado
//   (nada de atualização otimista); enquanto salva, o seletor mostra "Salvando".
// - 409 (versão): recarrega as preferências e avisa; 400/outros: mensagem fixa
//   (nunca o texto do servidor).
// - "loading": enquanto o GET não termina, os painéis mostram o esqueleto (evita
//   desenhar o padrão e trocar logo depois). "unavailable": o GET falhou → usa
//   os padrões e NÃO oferece o seletor (sem `version` não há como salvar).
// =============================================================================

export type ChartPrefsStatus = "loading" | "ready" | "unavailable";

export interface ChartPrefsNotice {
  panel: DashboardChartPanel;
  kind: "conflict" | "error";
  text: string;
}

export const CONFLICT_MESSAGE =
  "As preferências foram alteradas em outra sessão. Recarregamos os valores atuais; escolha de novo se ainda quiser mudar.";
export const SAVE_ERROR_MESSAGE = "Não foi possível salvar o tipo de gráfico. Tente novamente.";

export interface DashboardChartPrefs {
  status: ChartPrefsStatus;
  charts: DashboardChartsPrefs;
  /** PATCH em andamento (qualquer painel). */
  busy: boolean;
  savingPanel: DashboardChartPanel | null;
  notice: ChartPrefsNotice | null;
  select: <P extends DashboardChartPanel>(panel: P, value: DashboardChartType<P>) => void;
  restore: (panel: DashboardChartPanel) => void;
}

interface Variables {
  panel: DashboardChartPanel;
  value: string | null;
  version: number;
}

export function useDashboardChartPrefs(): DashboardChartPrefs {
  const queryClient = useQueryClient();
  const query = useMyPreferences();
  const [notice, setNotice] = useState<ChartPrefsNotice | null>(null);

  const mutation = useMutation({
    mutationFn: ({ panel, value, version }: Variables) =>
      updateMyPreferences({
        version,
        // A allowlist do valor é a do menu; o backend revalida (400 se inválido).
        dashboard_charts: { [panel]: value } as DashboardChartsUpdate,
      }),
    onSuccess: (saved) => {
      persistUiPreferences(saved);
      queryClient.setQueryData(MY_PREFERENCES_QUERY_KEY, saved);
    },
    onError: (error, { panel }) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: MY_PREFERENCES_QUERY_KEY });
        setNotice({ panel, kind: "conflict", text: CONFLICT_MESSAGE });
        return;
      }
      setNotice({ panel, kind: "error", text: SAVE_ERROR_MESSAGE });
    },
  });

  const { mutate, isPending, variables } = mutation;
  const data = query.data;

  const save = useCallback(
    (panel: DashboardChartPanel, value: string | null) => {
      if (!data || isPending) return;
      setNotice(null);
      mutate({ panel, value, version: data.version });
    },
    [data, isPending, mutate],
  );

  const status: ChartPrefsStatus = query.isPending ? "loading" : data ? "ready" : "unavailable";

  return {
    status,
    charts: data?.dashboard_charts ?? DEFAULT_DASHBOARD_CHARTS,
    busy: isPending,
    savingPanel: isPending && variables ? variables.panel : null,
    notice,
    select: (panel, value) => save(panel, value),
    restore: (panel) => save(panel, null),
  };
}
