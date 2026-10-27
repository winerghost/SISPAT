"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, LayoutGrid, RotateCcw } from "lucide-react";

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
import { samePanelPrefs, type PanelCatalogItem, type PanelPref, type PanelSize } from "@/lib/preferences-api";
import { cn } from "@/lib/utils";

import { useDashboardPanelPrefs } from "./use-dashboard-panel-prefs";

// =============================================================================
// "Personalizar painéis" — catálogo de 12 painéis vindo do BACKEND
// (`GET /dashboard/panels`: só o que o perfil pode ver). O cliente só apresenta
// e envia ids/visibilidade/tamanho; a validação e a permissão são do backend.
// - Rascunho LOCAL enquanto o diálogo está aberto; "Salvar" envia
//   `PUT {version, panels}` e "Restaurar padrão" envia `{version, restore_default}`.
//   A grade só muda depois da confirmação (409/403: recarrega e redefine o rascunho).
// - Ordem: ARRASTAR (ponteiro, pela alça) E botões "Mover para cima/baixo"
//   (nome acessível com o painel). Ao mover, o foco acompanha o painel e a nova
//   posição é anunciada (aria-live).
// - Tamanho P/M/G por painel (só os admitidos pelo catálogo), grupo de rádios nativo.
// - Pelo menos 1 painel visível (o backend também recusa).
// - Dialog (Radix): foco preso, Esc fecha, foco volta ao gatilho. Superfície clara
//   (DESIGN.md: Light Surface Card), alvos >= 24px.
// =============================================================================

const ALL_HIDDEN_MESSAGE = "Mantenha pelo menos um painel visível.";
const SAVED_MESSAGE = "Painéis do dashboard atualizados.";
const LOAD_ERROR_MESSAGE = "Não foi possível carregar os painéis. Tente novamente.";

const SIZE_LABEL: Record<PanelSize, string> = { P: "Pequeno", M: "Médio", G: "Grande" };

type Direction = "up" | "down";

/** Move `from` para `to` (índices finais); devolve a mesma lista se nada mudar. */
function moveTo(list: PanelPref[], from: number, to: number): PanelPref[] {
  if (from === to || from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function DashboardLayoutButton() {
  const prefs = useDashboardPanelPrefs();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PanelPref[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [saved, setSaved] = useState(false);
  const [focusTarget, setFocusTarget] = useState<{ id: string; direction: Direction } | null>(null);
  const [drag, setDrag] = useState<{ id: string; drop: number } | null>(null);
  const moveRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const listRef = useRef<HTMLOListElement>(null);

  const catalog = new Map<string, PanelCatalogItem>(prefs.catalog.map((item) => [item.id, item]));

  // Rascunho nasce quando o diálogo está aberto e os dados chegaram (inclusive
  // se o carregamento terminar depois da abertura / após "Tentar novamente").
  useEffect(() => {
    if (open && draft === null && prefs.status === "ready") setDraft(prefs.panels.map((p) => ({ ...p })));
  }, [open, draft, prefs.status, prefs.panels]);

  // Foco acompanha o painel movido (se o botão ficou desabilitado na borda, vai ao oposto).
  useEffect(() => {
    if (!focusTarget) return;
    const { id, direction } = focusTarget;
    const same = moveRefs.current.get(`${id}:${direction}`);
    const other = moveRefs.current.get(`${id}:${direction === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : other)?.focus();
    setFocusTarget(null);
  }, [focusTarget, draft]);

  const openDialog = (next: boolean) => {
    if (next) {
      setDraft(prefs.status === "ready" ? prefs.panels.map((p) => ({ ...p })) : null);
      setError(null);
      setAnnouncement("");
      setSaved(false);
    } else {
      setDrag(null);
    }
    setOpen(next);
  };

  const list = draft ?? [];
  const label = (id: string) => catalog.get(id)?.label ?? id;
  const allHidden = list.length > 0 && list.every((p) => !p.visible);
  const unchanged = draft === null || samePanelPrefs(draft, prefs.panels);

  const update = (id: string, patch: Partial<Pick<PanelPref, "visible" | "size">>) => {
    setError(null);
    setDraft((current) => current && current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const reorder = (id: string, to: number, direction: Direction) => {
    const from = list.findIndex((p) => p.id === id);
    const next = moveTo(list, from, to);
    if (next === list) return;
    setError(null);
    setDraft(next);
    setFocusTarget({ id, direction });
    setAnnouncement(`${label(id)} movido para a posição ${to + 1} de ${next.length}.`);
  };

  // --- Arrastar (ponteiro): a lista só muda ao soltar; uma barra marca o destino.
  const dropIndexAt = (clientY: number): number => {
    let gap = 0;
    for (const el of Array.from(listRef.current?.children ?? [])) {
      const rect = el.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) gap += 1;
    }
    return gap;
  };
  const onGripDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (prefs.saving || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, drop: dropIndexAt(event.clientY) });
  };
  const onGripMove = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (drag?.id === id) setDrag({ id, drop: dropIndexAt(event.clientY) });
  };
  const onGripUp = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (drag?.id !== id) return;
    const from = list.findIndex((p) => p.id === id);
    const gap = dropIndexAt(event.clientY);
    const to = gap > from ? gap - 1 : gap;
    setDrag(null);
    reorder(id, to, to < from ? "up" : "down");
  };

  const finish = async (request: Parameters<typeof prefs.save>[0]) => {
    setError(null);
    const result = await prefs.save(request);
    if (result.ok) {
      setSaved(true);
      setOpen(false);
      setDraft(null);
      return;
    }
    setError(result.message);
    // Conflito/painel proibido: o rascunho passa a refletir o estado do servidor.
    if (result.fresh) setDraft(result.fresh.map((p) => ({ ...p })));
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
        <DialogContent className="max-w-2xl" data-dashboard-layout-dialog>
          <DialogHeader>
            <DialogTitle>Personalizar painéis</DialogTitle>
            <DialogDescription>
              Escolha quais painéis aparecem no seu dashboard, a ordem (arraste pela alça ou use os botões) e o
              tamanho: P (pequeno), M (médio) ou G (grande). A escolha fica salva na sua conta.
            </DialogDescription>
          </DialogHeader>

          {prefs.status === "loading" ? (
            <p role="status" className="text-body-sm text-graphite-mid" data-layout-loading>
              Carregando painéis…
            </p>
          ) : prefs.status === "unavailable" ? (
            <div className="flex flex-col items-start gap-2" data-layout-load-error>
              <FormMessage surface="light">{LOAD_ERROR_MESSAGE}</FormMessage>
              <Button type="button" variant="outlineOnLight" onClick={() => void prefs.reload()}>
                Tentar novamente
              </Button>
            </div>
          ) : (
            <ol ref={listRef} aria-label="Painéis do dashboard" className="m-0 flex list-none flex-col p-0">
              {list.map((panel, index) => {
                const item = catalog.get(panel.id);
                if (!item) return null;
                const checkboxId = `dash-layout-${panel.id}`;
                const descId = `${checkboxId}-desc`;
                const dragging = drag?.id === panel.id;
                const barTop = drag !== null && drag.drop === index;
                const barBottom = drag !== null && drag.drop === list.length && index === list.length - 1;
                return (
                  <li
                    key={panel.id}
                    data-layout-item={panel.id}
                    className={cn(
                      "relative flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-graphite-mid/20 py-2 last:border-b-0",
                      dragging && "opacity-60",
                    )}
                  >
                    <span
                      aria-hidden
                      data-layout-grip
                      className="inline-flex h-8 w-6 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-sm text-graphite-mid hover:text-obsidian-canvas active:cursor-grabbing"
                      onPointerDown={(event) => onGripDown(event, panel.id)}
                      onPointerMove={(event) => onGripMove(event, panel.id)}
                      onPointerUp={(event) => onGripUp(event, panel.id)}
                      onPointerCancel={() => setDrag(null)}
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <div className="min-w-[10rem] flex-1">
                      <label
                        htmlFor={checkboxId}
                        className={cn(
                          "flex min-h-8 min-w-0 cursor-pointer items-center gap-3 rounded-nav py-1 text-body-sm",
                          panel.visible ? "text-obsidian-canvas" : "text-graphite-mid line-through",
                        )}
                      >
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={panel.visible}
                          aria-describedby={item.description ? descId : undefined}
                          onChange={(event) => update(panel.id, { visible: event.target.checked })}
                          className="h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-obsidian-canvas focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-bone"
                        />
                        <span className="min-w-0 break-words">
                          {item.label}
                          <span className="sr-only">{panel.visible ? " (visível)" : " (oculto)"}</span>
                        </span>
                      </label>
                      {item.description ? (
                        <p id={descId} className="m-0 pl-7 text-caption text-graphite-mid">
                          {item.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1 pl-8 sm:pl-0">
                      <fieldset className="m-0 flex min-w-0 gap-1 border-0 p-0">
                        <legend className="sr-only">Tamanho de {item.label}</legend>
                        {item.sizes.map((size) => (
                          <label
                            key={size}
                            className="relative inline-flex h-8 w-8 cursor-pointer items-center justify-center"
                          >
                            <input
                              type="radio"
                              name={`dash-size-${panel.id}`}
                              value={size}
                              checked={panel.size === size}
                              onChange={() => update(panel.id, { size })}
                              className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-sm opacity-0"
                            />
                            <span
                              aria-hidden
                              className="transition-factory pointer-events-none inline-flex h-8 w-8 items-center justify-center rounded-sm border border-graphite-mid text-body-sm text-obsidian-canvas peer-checked:border-obsidian-canvas peer-checked:bg-obsidian-canvas peer-checked:text-bone peer-focus-visible:ring-1 peer-focus-visible:ring-obsidian-canvas peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bone"
                            >
                              {size}
                            </span>
                            <span className="sr-only">{SIZE_LABEL[size]}</span>
                          </label>
                        ))}
                      </fieldset>
                      {(["up", "down"] as const).map((direction) => (
                        <Button
                          key={direction}
                          ref={(el) => {
                            moveRefs.current.set(`${panel.id}:${direction}`, el);
                          }}
                          type="button"
                          variant="outlineOnLight"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          disabled={direction === "up" ? index === 0 : index === list.length - 1}
                          aria-label={`Mover ${item.label} para ${direction === "up" ? "cima" : "baixo"}`}
                          onClick={() => reorder(panel.id, direction === "up" ? index - 1 : index + 1, direction)}
                        >
                          {direction === "up" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                        </Button>
                      ))}
                    </div>
                    <span
                      aria-hidden
                      data-layout-drop={barTop ? "before" : barBottom ? "after" : undefined}
                      className={cn(
                        "transition-factory-press pointer-events-none absolute inset-x-0 h-0.5 bg-obsidian-canvas",
                        barBottom ? "bottom-0" : "top-0",
                        barTop || barBottom ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </li>
                );
              })}
            </ol>
          )}
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
              disabled={prefs.status !== "ready" || prefs.isDefault || prefs.saving}
              onClick={() => void finish({ restore: true })}
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
                onClick={() => draft && void finish({ panels: draft })}
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
