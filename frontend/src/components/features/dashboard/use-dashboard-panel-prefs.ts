"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api-client";
import {
  getDashboardPanels,
  samePanelPrefs,
  updateDashboardPanels,
  type DashboardPanelsData,
  type PanelCatalogItem,
  type PanelPref,
} from "@/lib/preferences-api";

import type { ChartPrefsStatus } from "./use-dashboard-chart-prefs";

// =============================================================================
// Personalização dos 12 painéis (catálogo, ordem, visibilidade e tamanho P/M/G).
// - Fonte de verdade: `GET /api/v1/dashboard/panels` (só o que o PERFIL pode ver);
//   gravação: `PUT /api/v1/dashboard/preferences` (`panels` ou `restore_default`).
// - Estado honesto: a grade só muda DEPOIS de o PUT ser confirmado; o diálogo edita
//   um rascunho local. Nada vai para localStorage.
// - 409 (versão) e 403 `panel_forbidden`: recarrega do servidor e devolve o
//   estado novo para o rascunho ser redefinido. Mensagens fixas (nunca o texto
//   do servidor).
// Mesma chave de cache para quem renderiza a grade: `useDashboardPanelPrefs()`.
// =============================================================================

export const DASHBOARD_PANELS_QUERY_KEY = ["dashboard", "panels"] as const;

export const PANELS_CONFLICT_MESSAGE =
  "As preferências foram alteradas em outra sessão. Recarregamos os painéis atuais; revise e salve de novo.";
export const PANELS_FORBIDDEN_MESSAGE =
  "Um dos painéis não está disponível para o seu perfil. Atualizamos a lista; revise e salve de novo.";
export const PANELS_SAVE_ERROR_MESSAGE =
  "Não foi possível salvar os painéis. Mantenha pelo menos um painel visível e tente novamente.";

export type PanelsSaveResult =
  | { ok: true }
  | { ok: false; kind: "conflict" | "forbidden" | "error"; message: string; fresh?: PanelPref[] };

export type PanelsUpdate = { panels: PanelPref[] } | { restore: true };

export interface DashboardPanelPrefs {
  status: ChartPrefsStatus;
  /** Catálogo permitido ao perfil (vazio enquanto não carregou). */
  catalog: PanelCatalogItem[];
  /** Layout padrão do perfil. */
  defaultLayout: PanelPref[];
  /** Preferências CONFIRMADAS pelo backend: lista completa, em ordem de exibição. */
  panels: PanelPref[];
  /** Só os visíveis, em ordem (para quem renderiza a grade). */
  visible: PanelPref[];
  isDefault: boolean;
  saving: boolean;
  save: (update: PanelsUpdate) => Promise<PanelsSaveResult>;
  /** Tenta carregar de novo (estado de erro). */
  reload: () => Promise<void>;
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

const EMPTY: never[] = [];

export function useDashboardPanelPrefs(): DashboardPanelPrefs {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DASHBOARD_PANELS_QUERY_KEY,
    queryFn: getDashboardPanels,
    retry: shouldRetry,
    staleTime: 60_000,
  });
  const data = query.data;
  const { refetch } = query;

  const mutation = useMutation({
    mutationFn: ({ update, current }: { update: PanelsUpdate; current: DashboardPanelsData }) =>
      updateDashboardPanels(
        "restore" in update
          ? { version: current.version, restore_default: true }
          : { version: current.version, panels: update.panels },
        current.catalog,
      ),
    onSuccess: (saved, { current }) => {
      queryClient.setQueryData<DashboardPanelsData>(DASHBOARD_PANELS_QUERY_KEY, {
        ...current,
        panels: saved.panels,
        version: saved.version,
      });
    },
  });
  const { mutateAsync, isPending } = mutation;

  const save = useCallback(
    async (update: PanelsUpdate): Promise<PanelsSaveResult> => {
      if (!data) return { ok: false, kind: "error", message: PANELS_SAVE_ERROR_MESSAGE };
      try {
        await mutateAsync({ update, current: data });
        return { ok: true };
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        const forbidden = error instanceof ApiError && error.status === 403 && error.code === "panel_forbidden";
        if (conflict || forbidden) {
          const fresh = (await refetch()).data?.panels;
          return {
            ok: false,
            kind: conflict ? "conflict" : "forbidden",
            message: conflict ? PANELS_CONFLICT_MESSAGE : PANELS_FORBIDDEN_MESSAGE,
            fresh,
          };
        }
        return { ok: false, kind: "error", message: PANELS_SAVE_ERROR_MESSAGE };
      }
    },
    [data, mutateAsync, refetch],
  );

  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const status: ChartPrefsStatus = query.isPending ? "loading" : data ? "ready" : "unavailable";
  const panels = data?.panels ?? EMPTY;
  return {
    status,
    catalog: data?.catalog ?? EMPTY,
    defaultLayout: data?.defaultLayout ?? EMPTY,
    panels,
    visible: panels.filter((p) => p.visible),
    isDefault: data ? samePanelPrefs(data.panels, data.defaultLayout) : true,
    saving: isPending,
    save,
    reload,
  };
}
