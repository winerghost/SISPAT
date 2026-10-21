"use client";

import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api-client";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  updateMyPreferences,
  type DashboardLayout,
  type DashboardLayoutUpdate,
} from "@/lib/preferences-api";
import { persistUiPreferences } from "@/lib/ui-preferences";
import { MY_PREFERENCES_QUERY_KEY, useMyPreferences } from "@/lib/use-my-preferences";

import type { ChartPrefsStatus } from "./use-dashboard-chart-prefs";

// =============================================================================
// Painéis visíveis e ordem do dashboard (preferência `dashboard_layout`).
// - Fonte de verdade: `GET /api/v1/me/preferences`. Backend anterior (sem a
//   chave) = layout padrão (ver preferences-api.ts).
// - Estado honesto: a grade só muda DEPOIS de o PATCH ser confirmado; o diálogo
//   edita um rascunho local e nada vai para localStorage.
// - 409: recarrega as preferências e avisa; 400/outros: mensagem fixa.
// =============================================================================

export const LAYOUT_CONFLICT_MESSAGE =
  "As preferências foram alteradas em outra sessão. Recarregamos os painéis atuais; revise e salve de novo.";
export const LAYOUT_SAVE_ERROR_MESSAGE =
  "Não foi possível salvar os painéis. Mantenha pelo menos um painel visível e tente novamente.";

export type LayoutSaveResult = { ok: true } | { ok: false; kind: "conflict" | "error"; message: string };

export interface DashboardLayoutPrefs {
  status: ChartPrefsStatus;
  /** Layout CONFIRMADO pelo backend (ou o padrão, sem preferências). */
  layout: DashboardLayout;
  saving: boolean;
  /** PATCH `{order, hidden}`; `null` restaura o padrão. */
  save: (update: DashboardLayoutUpdate) => Promise<LayoutSaveResult>;
}

export function useDashboardLayoutPrefs(): DashboardLayoutPrefs {
  const queryClient = useQueryClient();
  const query = useMyPreferences();
  const data = query.data;

  const mutation = useMutation({
    mutationFn: ({ update, version }: { update: DashboardLayoutUpdate; version: number }) =>
      updateMyPreferences({ version, dashboard_layout: update }),
    onSuccess: (saved) => {
      persistUiPreferences(saved);
      queryClient.setQueryData(MY_PREFERENCES_QUERY_KEY, saved);
    },
  });
  const { mutateAsync, isPending } = mutation;

  const save = useCallback(
    async (update: DashboardLayoutUpdate): Promise<LayoutSaveResult> => {
      if (!data) return { ok: false, kind: "error", message: LAYOUT_SAVE_ERROR_MESSAGE };
      try {
        await mutateAsync({ update, version: data.version });
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await queryClient.invalidateQueries({ queryKey: MY_PREFERENCES_QUERY_KEY });
          return { ok: false, kind: "conflict", message: LAYOUT_CONFLICT_MESSAGE };
        }
        return { ok: false, kind: "error", message: LAYOUT_SAVE_ERROR_MESSAGE };
      }
    },
    [data, mutateAsync, queryClient],
  );

  const status: ChartPrefsStatus = query.isPending ? "loading" : data ? "ready" : "unavailable";
  return {
    status,
    layout: data?.dashboard_layout ?? DEFAULT_DASHBOARD_LAYOUT,
    saving: isPending,
    save,
  };
}
