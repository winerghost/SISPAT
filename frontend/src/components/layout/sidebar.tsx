"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { m } from "motion/react";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMe } from "@/lib/session";
import { fade } from "@/lib/motion/presets";
import { TRANSITION_BASE } from "@/lib/motion/tokens";
import { filterNavItems, NAV_ITEMS, type NavGroup } from "./nav-items";

// =============================================================================
// Sidebar — shell de navegação reutilizável do SISPAT-AGU.
// =============================================================================
// Superfície "Carbon Lift" (um nível acima do canvas, ver DESIGN.md >
// Surfaces), hairline ash-stroke como divisor à direita. Rótulos em Geist
// 14px peso 400 — nunca bold.
//
// Movimento (DESIGN.md > Motion Philosophy — 150–200ms, ease factory, tween):
//  - recolher/expandir: transição de `width` 200ms (256px ↔ 64px). Só ícones
//    no modo recolhido; o rótulo continua no DOM como `sr-only` (nome
//    acessível) e um tooltip visual aparece no hover/foco (Esc fecha);
//  - indicador da página ativa: uma única barra signal-orange (o "Status
//    Pulse" do DESIGN.md, "você está aqui") que desliza por `transform` até o
//    item ativo. Não usa `layoutId`: o MotionProvider carrega só
//    `domAnimation` (sem layout projection) — medir e animar `y` dá o mesmo
//    efeito sem aumentar o bundle;
//  - cores de itens/ícones trocam juntas (`transition-factory`, 150ms);
//  - submenu: `aria-expanded`/`aria-controls`, entrada fade 200ms.
// Sob prefers-reduced-motion o MotionConfig("user") desliga o deslocamento e o
// CSS global zera a transição de largura.
//
// Estado recolhido: sessionStorage (só nesta aba; nunca localStorage).
// =============================================================================

const COLLAPSED_KEY = "sispat-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.sessionStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.sessionStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    /* storage indisponível: estado fica só em memória */
  }
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const NAV_FOCUS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bone focus-visible:ring-offset-1 focus-visible:ring-offset-carbon-lift";

export function Sidebar() {
  // Desktop (>= lg). Abaixo de lg a navegação vive no menu móvel
  // (`MobileNav`, aberto pelo botão do Header).
  // SSR sempre expandido (HTML idêntico servidor/cliente); o estado salvo é
  // aplicado após a montagem, ANTES de ligar a transição — sem animação na carga.
  const [collapsed, setCollapsed] = useState(false);
  const [transitionReady, setTransitionReady] = useState(false);
  const navId = useId();

  useEffect(() => {
    setCollapsed(readCollapsed());
    const frame = requestAnimationFrame(() => setTransitionReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const setAndPersist = useCallback((next: boolean) => {
    writeCollapsed(next);
    setCollapsed(next);
  }, []);

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "hidden h-screen shrink-0 flex-col overflow-hidden border-r border-ash-stroke bg-carbon-lift lg:flex",
        collapsed ? "w-16" : "w-64",
        transitionReady && "transition-[width] duration-base ease-factory",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b border-ash-stroke px-3",
          collapsed ? "justify-center" : "justify-between gap-2",
        )}
      >
        <span className={cn("truncate pl-3 text-eyebrow text-bone", collapsed && "sr-only")}>
          SISPAT-AGU
        </span>
        <button
          type="button"
          onClick={() => setAndPersist(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls={navId}
          aria-label={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-buttons text-warm-granite transition-factory hover:bg-obsidian-canvas/60 hover:text-bone",
            NAV_FOCUS,
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <SidebarNav
        id={navId}
        label="Navegação principal"
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4"
        collapsed={collapsed}
        onRequestExpand={() => setAndPersist(false)}
      />
    </aside>
  );
}

interface TooltipState {
  label: string;
  top: number;
  left: number;
}

/**
 * Lista de navegação reutilizada pela sidebar desktop e pelo menu móvel.
 * `onNavigate` permite ao menu móvel fechar-se ao escolher um destino.
 */
export function SidebarNav({
  id,
  label,
  className,
  onNavigate,
  collapsed = false,
  onRequestExpand,
}: {
  id?: string;
  label: string;
  className?: string;
  onNavigate?: () => void;
  /** Modo recolhido (só ícones + tooltip). */
  collapsed?: boolean;
  /** Pedido para expandir a sidebar (ex.: clique num grupo no modo recolhido). */
  onRequestExpand?: () => void;
}) {
  const pathname = usePathname();
  // Perfil vem do backend (`GET /api/v1/me`). Ocultar "Administração" para
  // USER/RH é SÓ UX — a autorização real continua no Flask (403). Sem perfil
  // conhecido (carregando/erro/sem sessão) os itens restritos ficam ocultos.
  const { data: me } = useMe();
  const roles = me?.roles;
  const items = useMemo(() => filterNavItems(NAV_ITEMS, roles), [roles]);

  // Grupos começam expandidos quando a rota atual está dentro deles.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const item of NAV_ITEMS) {
      if (item.children) initial[item.href] = isActive(pathname, item.href);
    }
    return initial;
  });

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  useEffect(() => {
    if (!collapsed) setTooltip(null);
  }, [collapsed]);

  const showTooltip = useCallback(
    (text: string, el: HTMLElement) => {
      if (!collapsed) return;
      const rect = el.getBoundingClientRect();
      setTooltip({ label: text, top: rect.top + rect.height / 2, left: rect.right + 8 });
    },
    [collapsed],
  );
  const hideTooltip = useCallback(() => setTooltip(null), []);

  function handleGroupClick(href: string) {
    if (collapsed) {
      // Recolhida não há espaço para o submenu: expande e abre o grupo.
      setOpenGroups((prev) => ({ ...prev, [href]: true }));
      setTooltip(null);
      onRequestExpand?.();
      return;
    }
    setOpenGroups((prev) => ({ ...prev, [href]: !prev[href] }));
  }

  // Setas ↑/↓, Home/End movem o foco entre os itens visíveis (Tab continua
  // funcionando normalmente); Esc fecha o tooltip (WCAG 1.4.13).
  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      setTooltip(null);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const focusables = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]"),
    ).filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = focusables.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(current + 1, focusables.length - 1);
    else next = current < 0 ? focusables.length - 1 : Math.max(current - 1, 0);
    event.preventDefault();
    focusables[next]?.focus();
  }

  const listRef = useRef<HTMLDivElement>(null);
  const indicatorY = useActiveIndicator(listRef, [pathname, openGroups, collapsed, items]);

  return (
    <nav id={id} aria-label={label} className={className} onKeyDown={handleKeyDown}>
      <div ref={listRef} className="relative">
        {indicatorY !== null && (
          <m.span
            data-nav-indicator
            aria-hidden="true"
            className="pointer-events-none absolute left-[-8px] top-0 h-4 w-0.5 rounded-full bg-signal-orange"
            initial={false}
            animate={{ y: indicatorY }}
            transition={TRANSITION_BASE}
          />
        )}
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <NavEntry
              key={item.href}
              item={item}
              pathname={pathname}
              open={!!openGroups[item.href]}
              collapsed={collapsed}
              onToggle={() => handleGroupClick(item.href)}
              onNavigate={onNavigate}
              onHover={showTooltip}
              onLeave={hideTooltip}
            />
          ))}
        </ul>
      </div>
      {collapsed && tooltip && (
        // Tooltip só visual (o nome acessível já está no item, via sr-only).
        <span
          aria-hidden="true"
          data-nav-tooltip
          className="pointer-events-none fixed z-50 -translate-y-1/2 animate-fade-in whitespace-nowrap rounded-nav bg-bone px-2 py-1 text-caption text-obsidian-canvas"
          style={{ top: tooltip.top, left: tooltip.left }}
        >
          {tooltip.label}
        </span>
      )}
    </nav>
  );
}

/**
 * Mede a posição vertical do alvo ativo (link com aria-current ou, se o
 * submenu estiver fechado, o botão do grupo) relativa à lista. `null` até a
 * 1ª medição (nada é renderizado no SSR → sem mismatch de hidratação).
 */
function useActiveIndicator(
  listRef: React.RefObject<HTMLDivElement | null>,
  deps: unknown[],
): number | null {
  const [y, setY] = useState<number | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const candidates = Array.from(
      list.querySelectorAll<HTMLElement>("[data-nav-active='true']"),
    ).filter((el) => el.offsetParent !== null);
    // Prefere o link da página (mais profundo) ao botão do grupo.
    const target = candidates.find((el) => el.tagName === "A") ?? candidates[0];
    if (!target) {
      setY(null);
      return;
    }
    const listRect = list.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    setY(Math.round(rect.top - listRect.top + rect.height / 2 - 8));
  }, [listRef]);

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, measure]);

  return y;
}

function NavEntry({
  item,
  pathname,
  open,
  collapsed,
  onToggle,
  onNavigate,
  onHover,
  onLeave,
}: {
  item: NavGroup;
  pathname: string;
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  onHover: (label: string, el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);
  const hasChildren = !!item.children?.length;
  const submenuId = useId();
  const expanded = open && !collapsed;

  const hoverProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onHover(item.label, e.currentTarget),
    onFocus: (e: React.FocusEvent<HTMLElement>) => onHover(item.label, e.currentTarget),
    onMouseLeave: onLeave,
    onBlur: onLeave,
  };

  const itemClass = cn(
    "flex w-full items-center gap-2 rounded-nav px-3 py-2 text-body-sm text-warm-granite transition-factory hover:bg-obsidian-canvas/60 hover:text-bone",
    NAV_FOCUS,
  );
  const labelClass = cn("min-w-0 flex-1 truncate text-left", collapsed && "sr-only");

  return (
    <li>
      {hasChildren ? (
        <button
          type="button"
          data-nav-item
          data-nav-active={active ? "true" : undefined}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={submenuId}
          className={cn(itemClass, active && "text-bone")}
          {...hoverProps}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className={labelClass}>{item.label}</span>
          {!collapsed && (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-fast ease-factory",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          )}
        </button>
      ) : (
        <Link
          href={item.href}
          data-nav-item
          data-nav-active={active ? "true" : undefined}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(itemClass, active && "bg-obsidian-canvas/60 text-bone")}
          {...hoverProps}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className={labelClass}>{item.label}</span>
        </Link>
      )}

      {hasChildren && (
        // Sempre no DOM (aria-controls válido); `hidden` quando fechado. Ao
        // abrir, os itens entram com fade 200ms (opacity — sem animar altura).
        <m.ul
          id={submenuId}
          hidden={!expanded}
          variants={fade}
          initial={false}
          animate={expanded ? "visible" : "hidden"}
          // `flex` sobrescreveria o display:none de [hidden] (mesma especificidade).
          className={cn(
            "mt-1 flex-col gap-1 border-l border-ash-stroke pl-3",
            expanded ? "flex" : "hidden",
          )}
        >
          {item.children!.map((child) => {
            const ChildIcon = child.icon;
            const childActive = isActive(pathname, child.href);
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  data-nav-item
                  data-nav-active={childActive ? "true" : undefined}
                  onClick={onNavigate}
                  aria-current={childActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-nav px-3 py-1.5 text-body-sm text-warm-granite transition-factory hover:bg-obsidian-canvas/60 hover:text-bone",
                    NAV_FOCUS,
                    childActive && "bg-obsidian-canvas/60 text-bone",
                  )}
                >
                  <ChildIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="flex-1">{child.label}</span>
                </Link>
              </li>
            );
          })}
        </m.ul>
      )}
    </li>
  );
}
