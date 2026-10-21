"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, LayoutGrid, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import {
  DASHBOARD_PANEL_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
  sameLayout,
  type DashboardLayout,
  type DashboardPanelId,
} from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

import { DASHBOARD_PANEL_META } from "./dashboard-panel-meta";
import { useDashboardLayoutPrefs } from "./use-dashboard-layout-prefs";

// =============================================================================
// "Personalizar painéis": cada usuário escolhe quais painéis vê e a ordem.
// - Rascunho LOCAL enquanto o diálogo está aberto; "Salvar" envia
//   `PATCH {dashboard_layout: {order, hidden}}` e "Restaurar padrão" envia
//   `{dashboard_layout: null}`. A grade só muda depois da confirmação.
// - Sem arrastar-e-soltar: checkbox "mostrar" + botões "Mover para cima/baixo"
//   (nome acessível com o painel). Ao mover, o foco acompanha o painel e a nova
//   posição é anunciada (aria-live). Pelo menos 1 painel visível (o backend
//   também recusa esconder todos com 400).
// - Superfície clara do Dialog (DESIGN.md: Light Surface Card), controles
//   nativos, alvos ≥ 24px.
// =============================================================================

const ALL_HIDDEN_MESSAGE = "Mantenha pelo menos um painel visível.";
const SAVED_MESSAGE = "Painéis do dashboard atualizados.";

type Direction = "up" | "down";

function move(order: DashboardPanelId[], index: number, direction: Direction): DashboardPanelId[] {
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function DashboardLayoutButton() {
  const prefs = useDashboardLayoutPrefs();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DashboardLayout>(prefs.layout);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [saved, setSaved] = useState(false);
  const moveRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const [focusTarget, setFocusTarget] = useState<{ id: DashboardPanelId; direction: Direction } | null>(null);

  // 409: depois de recarregar, o rascunho volta ao layout atual do servidor.
  const [conflictReset, setConflictReset] = useState(false);
  useEffect(() => {
    if (!conflictReset) return;
    setDraft({ order: [...prefs.layout.order], hidden: [...prefs.layout.hidden] });
    setConflictReset(false);
  }, [conflictReset, prefs.layout]);

  // Foco acompanha o painel movido (se o botão ficou desabilitado na borda, vai ao oposto).
  useEffect(() => {
    if (!focusTarget) return;
    const { id, direction } = focusTarget;
    const same = moveRefs.current.get(`${id}:${direction}`);
    const other = moveRefs.current.get(`${id}:${direction === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : other)?.focus();
    setFocusTarget(null);
  }, [focusTarget, draft]);

  if (prefs.status !== "ready") return null;

  const openDialog = (next: boolean) => {
    if (next) {
      setDraft({ order: [...prefs.layout.order], hidden: [...prefs.layout.hidden] });
      setError(null);
      setAnnouncement("");
      setSaved(false);
    }
    setOpen(next);
  };

  const hidden = new Set(draft.hidden);
  const allHidden = hidden.size >= DASHBOARD_PANEL_IDS.length;
  const unchanged = sameLayout(draft, prefs.layout);
  const isDefault = sameLayout(prefs.layout, DEFAULT_DASHBOARD_LAYOUT);

  const toggleVisible = (id: DashboardPanelId, visible: boolean) => {
    setError(null);
    setDraft((current) => ({
      order: current.order,
      hidden: visible ? current.hidden.filter((h) => h !== id) : [...current.hidden, id],
    }));
  };

  const moveItem = (id: DashboardPanelId, direction: Direction) => {
    const index = draft.order.indexOf(id);
    const order = move(draft.order, index, direction);
    if (order === draft.order) return;
    setError(null);
    setDraft({ order, hidden: draft.hidden });
    setFocusTarget({ id, direction });
    setAnnouncement(
      `${DASHBOARD_PANEL_META[id].title} movido para a posição ${order.indexOf(id) + 1} de ${order.length}.`,
    );
  };

  const finish = async (update: Parameters<typeof prefs.save>[0]) => {
    setError(null);
    const result = await prefs.save(update);
    if (result.ok) {
      setSaved(true);
      setOpen(false);
      return;
    }
    setError(result.message);
    if (result.kind === "conflict") setConflictReset(true);
  };

  return (
    <>
      <Button variant="ghost" className="h-10" onClick={() => openDialog(true)} data-dashboard-layout-trigger>
        <LayoutGrid aria-hidden />
        Personalizar painéis
      </Button>
      {/* Confirmação fora do diálogo (anunciada sem roubar o foco). */}
      <p role="status" className="sr-only" data-dashboard-layout-saved>
        {saved ? SAVED_MESSAGE : ""}
      </p>

      <Dialog open={open} onOpenChange={openDialog}>
        <DialogContent className="max-w-xl" data-dashboard-layout-dialog>
          <DialogHeader>
            <DialogTitle>Personalizar painéis</DialogTitle>
            <DialogDescription>
              Escolha quais painéis aparecem no seu dashboard e em que ordem. A escolha fica salva na sua conta e
              vale também para o relatório imprimível.
            </DialogDescription>
          </DialogHeader>

          <ol aria-label="Painéis do dashboard" className="m-0 flex list-none flex-col p-0">
            {draft.order.map((id, index) => {
              const meta = DASHBOARD_PANEL_META[id];
              const checkboxId = `dash-layout-${id}`;
              const visible = !hidden.has(id);
              return (
                <li
                  key={id}
                  data-layout-item={id}
                  className="flex min-w-0 items-center gap-2 border-b border-graphite-mid/20 py-1.5 last:border-b-0"
                >
                  <span aria-hidden className="w-6 shrink-0 text-right text-caption tabular-nums text-graphite-mid">
                    {index + 1}
                  </span>
                  <label
                    htmlFor={checkboxId}
                    className={cn(
                      "flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-nav py-1 text-body-sm",
                      visible ? "text-obsidian-canvas" : "text-graphite-mid line-through",
                    )}
                  >
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={visible}
                      onChange={(event) => toggleVisible(id, event.target.checked)}
                      className="h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-bone"
                    />
                    <span className="min-w-0 break-words">
                      {meta.title}
                      <span className="sr-only">{visible ? " (visível)" : " (oculto)"}</span>
                    </span>
                  </label>
                  {(["up", "down"] as const).map((direction) => (
                    <Button
                      key={direction}
                      ref={(el) => {
                        moveRefs.current.set(`${id}:${direction}`, el);
                      }}
                      type="button"
                      variant="outlineOnLight"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={direction === "up" ? index === 0 : index === draft.order.length - 1}
                      aria-label={`Mover ${meta.title} para ${direction === "up" ? "cima" : "baixo"}`}
                      onClick={() => moveItem(id, direction)}
                    >
                      {direction === "up" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                    </Button>
                  ))}
                </li>
              );
            })}
          </ol>
          <p aria-live="polite" className="sr-only" data-layout-announcement>
            {announcement}
          </p>

          {allHidden ? (
            <FormMessage surface="light" data-layout-error>
              {ALL_HIDDEN_MESSAGE}
            </FormMessage>
          ) : error ? (
            <FormMessage surface="light" data-layout-error>
              {error}
            </FormMessage>
          ) : null}

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outlineOnLight"
              disabled={isDefault || prefs.saving}
              onClick={() => void finish(null)}
            >
              <RotateCcw aria-hidden />
              Restaurar padrão
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outlineOnLight" disabled={prefs.saving} onClick={() => openDialog(false)}>
                Cancelar
              </Button>
              <Button
                type="button"
                loading={prefs.saving}
                disabled={allHidden || unchanged}
                onClick={() => void finish({ order: draft.order, hidden: draft.hidden })}
              >
                Salvar
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
