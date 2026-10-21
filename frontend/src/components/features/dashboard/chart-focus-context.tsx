"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

// =============================================================================
// Foco ao filtrar pelo gráfico (WCAG 2.4.3). Aplicar um filtro troca a
// queryKey: o bloco mostra o esqueleto e os botões (legenda / "Filtrar pelo
// gráfico") são desmontados — o foco cairia no <body>. Aqui:
// - `remember(patch)`: antes de filtrar, guarda QUAL botão (data-focus-id) de
//   QUAL bloco tinha o foco (clique de mouse no SVG não guarda nada);
// - `restore(blockId, root)`: quando o bloco volta a ter dados, devolve o foco
//   ao mesmo botão (ou ao "Filtrar pelo gráfico" do bloco). Só age se o foco
//   estiver PERDIDO (no <body>) e por poucos segundos — nunca rouba o foco de
//   outro controle;
// - estado aberto do "Filtrar pelo gráfico" sobrevive ao recarregamento.
// =============================================================================

const RESTORE_WINDOW_MS = 5_000;

interface Intent {
  block: string;
  focusId: string;
  at: number;
}

export interface ChartFocusApi {
  remember: () => void;
  restore: (blockId: string, root: HTMLElement | null) => void;
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
}

const ChartFocusContext = createContext<ChartFocusApi | null>(null);

export function useChartFocus(): ChartFocusApi | null {
  return useContext(ChartFocusContext);
}

function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

export function ChartFocusProvider({ children }: { children: ReactNode }) {
  const intent = useRef<Intent | null>(null);
  const [open, setOpenState] = useState<Record<string, boolean>>({});

  const remember = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    const target = active?.closest<HTMLElement>("[data-focus-id]");
    const block = active?.closest<HTMLElement>("[data-dashboard-block]");
    intent.current =
      target?.dataset.focusId && block?.dataset.dashboardBlock
        ? { block: block.dataset.dashboardBlock, focusId: target.dataset.focusId, at: Date.now() }
        : null;
  }, []);

  const restore = useCallback((blockId: string, root: HTMLElement | null) => {
    const current = intent.current;
    if (!current || current.block !== blockId || !root) return;
    if (Date.now() - current.at > RESTORE_WINDOW_MS) {
      intent.current = null;
      return;
    }
    if (!focusLost()) {
      intent.current = null;
      return;
    }
    const pick = (selector: string): HTMLElement | null => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) return null;
      return el.matches("button") ? el : el.querySelector<HTMLElement>("button");
    };
    const target = pick(`[data-focus-id="${CSS.escape(current.focusId)}"]`) ?? pick('[data-focus-id="atalhos"]');
    if (target) {
      target.focus();
      intent.current = null;
    }
  }, []);

  const api = useMemo<ChartFocusApi>(
    () => ({
      remember,
      restore,
      isOpen: (key) => open[key] ?? false,
      setOpen: (key, value) => setOpenState((state) => ({ ...state, [key]: value })),
    }),
    [remember, restore, open],
  );

  return <ChartFocusContext.Provider value={api}>{children}</ChartFocusContext.Provider>;
}
