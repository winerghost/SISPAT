import type { Page } from "@playwright/test";

// =============================================================================
// Verificações de layout executadas no navegador (page.evaluate).
// =============================================================================

export interface LayoutReport {
  viewport: { width: number; height: number };
  docScrollWidth: number;
  mainOverflowX: number;
  /** Elementos que escapam do viewport fora de um contêiner com rolagem própria. */
  outOfViewport: string[];
  /** Alvos interativos < 24x24px (WCAG 2.5.8), sem exceção aplicável. */
  smallTargets: string[];
  /** Pares de alvos interativos sobrepostos. */
  overlapping: string[];
  /** Textos com fonte < 12px. */
  tinyText: string[];
  /** Regiões principais sobrepostas (header × main × sidebar). */
  regionOverlap: string[];
  /** Diálogo aberto que não cabe na tela (ou não rola). */
  dialogIssues: string[];
}

export interface ScrollReport {
  viewport: { width: number; height: number };
  docScrollHeight: number;
  docClientHeight: number;
  scrollYAfter: number;
  mainScrollHeight: number;
  mainClientHeight: number;
  /** scrollHeight do <main> menos o fim do último conteúdo visível (px): sobra = rolagem fantasma. */
  mainGhostPx: number;
  docScrollWidth: number;
}

/**
 * Medidas verticais do documento e do <main>. O app tem UMA rolagem vertical
 * (a do <main>): a janela nunca deve rolar, nem com `scrollTo(0, 9999)`.
 */
export async function collectScrollReport(page: Page): Promise<ScrollReport> {
  return page.evaluate(() => {
    window.scrollTo(0, 9999);
    document.scrollingElement?.scrollTo(0, 9999);
    const doc = document.documentElement;
    const main = document.querySelector("main") as HTMLElement | null;

    let ghost = 0;
    let mainScrollHeight = 0;
    let mainClientHeight = 0;
    if (main) {
      mainScrollHeight = main.scrollHeight;
      mainClientHeight = main.clientHeight;
      const mainTop = main.getBoundingClientRect().top;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      let contentBottom = 0;
      for (const el of Array.from(main.querySelectorAll("*"))) {
        if (el.closest(".sr-only, [aria-hidden='true'], nextjs-portal, [data-sonner-toaster]")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        contentBottom = Math.max(contentBottom, r.bottom - mainTop + main.scrollTop);
      }
      // Só há "fantasma" se o <main> realmente rola; sem overflow a sobra é só espaço vazio.
      ghost =
        mainScrollHeight > mainClientHeight + 1
          ? Math.max(0, mainScrollHeight - (contentBottom + padBottom))
          : 0;
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      docScrollHeight: doc.scrollHeight,
      docClientHeight: window.innerHeight,
      scrollYAfter: window.scrollY,
      mainScrollHeight,
      mainClientHeight,
      mainGhostPx: Math.round(ghost * 10) / 10,
      docScrollWidth: doc.scrollWidth,
    };
  });
}

export async function collectLayoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TOL = 1;

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const name =
        el.getAttribute("aria-label") ||
        (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) ||
        el.getAttribute("placeholder") ||
        "";
      return `${tag}${el.id ? `#${el.id}` : ""}[${name}]`;
    }

    function isHiddenFromUser(el: Element): boolean {
      if (el.closest("[aria-hidden='true'], [inert], nextjs-portal")) return true;
      // Conteúdo visualmente oculto (tabelas alternativas dos gráficos): contido por um ancestral .sr-only.
      if (el.closest(".sr-only")) return true;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return true;
      // Padrão sr-only (ex.: "Pular para o conteúdo" fora de foco).
      if (style.clip === "rect(0px, 0px, 0px, 0px)" && style.position === "absolute") return true;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return true;
      // sr-only (clip 1px)
      if (rect.width <= 1 && rect.height <= 1) return true;
      return false;
    }

    /** Ancestral (até <main>, exclusive) com rolagem horizontal própria ou que recorta o excedente (ex.: viewport de carrossel). */
    function scrollContainer(el: Element): Element | null {
      let node = el.parentElement;
      while (node && node.tagName !== "MAIN" && node !== document.body) {
        const ox = getComputedStyle(node).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return node;
        node = node.parentElement;
      }
      return null;
    }

    /** Interseção do retângulo com a área visível de cada ancestral que corta/rola o conteúdo (ou null se vazia). */
    function visibleRect(el: Element, rect: DOMRect): DOMRect | null {
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      let node: Element | null = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const clipsX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
        const clipsY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
        if (clipsX || clipsY) {
          const box = node.getBoundingClientRect();
          if (clipsX) {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
          if (clipsY) {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
        }
        node = node.parentElement;
      }
      if (right - left <= 0 || bottom - top <= 0) return null;
      return new DOMRect(left, top, right - left, bottom - top);
    }

    /** `sticky` = elemento dentro de uma barra sticky; `under` = alvo dentro de um contêiner que ainda rola na vertical. */
    function coveredBySticky(sticky: Element, under: Element): boolean {
      let bar: Element | null = sticky;
      let isSticky = false;
      while (bar && bar !== document.body) {
        if (getComputedStyle(bar).position === "sticky") {
          isSticky = true;
          break;
        }
        bar = bar.parentElement;
      }
      if (!isSticky || !bar || bar.contains(under)) return false;
      let node: Element | null = under.parentElement;
      while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY;
        if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) return node.contains(bar);
        node = node.parentElement;
      }
      return false;
    }

    // 1) Rolagem horizontal da página.
    const main = document.querySelector("main");
    const mainOverflowX = main ? main.scrollWidth - main.clientWidth : 0;

    const outOfViewport: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (isHiddenFromUser(el)) continue;
      if (el.closest("[data-sonner-toaster]")) continue;
      const container = scrollContainer(el);
      const rect = (container ?? el).getBoundingClientRect();
      if (rect.right > vw + TOL || rect.left < -TOL) {
        outOfViewport.push(`${describe(el)} [${Math.round(rect.left)}→${Math.round(rect.right)}]`);
      }
    }

    // 2) Alvos de toque.
    const interactiveSelector =
      "a[href], button, input:not([type='hidden']), select, textarea, [role='button'], [role='link'], [tabindex]:not([tabindex='-1'])";
    const targets = Array.from(document.querySelectorAll(interactiveSelector)).filter(
      (el) => !isHiddenFromUser(el) && !(el as HTMLButtonElement).disabled,
    );
    const smallTargets: string[] = [];
    const targetRects: { el: Element; rect: DOMRect }[] = [];
    for (const el of targets) {
      const input = el as HTMLInputElement;
      const box =
        (input.type === "checkbox" || input.type === "radio") && el.closest("label")
          ? el.closest("label")!
          : el;
      const rect = box.getBoundingClientRect();
      // Alvo rolado para fora da área visível de um contêiner com rolagem (ex.: corpo do
      // formulário atrás da barra de ações fixa) não está na tela: não entra na sobreposição.
      const visible = visibleRect(box, rect);
      if (visible) targetRects.push({ el: box, rect: visible });
      // Exceção "inline": link dentro de frase/parágrafo.
      const inline = el.tagName === "A" && !!el.closest("p, li > span, dd");
      if (!inline && (rect.width < 24 - 0.5 || rect.height < 24 - 0.5)) {
        smallTargets.push(`${describe(el)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }

    // 3) Sobreposição entre alvos (ignora pai/filho e itens fora do viewport visível do contêiner).
    const overlapping: string[] = [];
    for (let i = 0; i < targetRects.length; i++) {
      for (let j = i + 1; j < targetRects.length; j++) {
        const a = targetRects[i]!;
        const b = targetRects[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // Barra "sticky" (ex.: ações do painel) sobre conteúdo que ainda rola: o conteúdo sai de baixo dela ao rolar.
        if (coveredBySticky(a.el, b.el) || coveredBySticky(b.el, a.el)) continue;
        const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (w > 2 && h > 2) overlapping.push(`${describe(a.el)} × ${describe(b.el)}`);
      }
    }

    // 4) Texto legível (>= 12px).
    const tinyText: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || isHiddenFromUser(parent)) continue;
      if (parent.closest("script, style, noscript")) continue;
      const size = parseFloat(getComputedStyle(parent).fontSize);
      if (size < 12) tinyText.push(`${describe(parent)} ${size}px`);
    }

    // 5) Regiões principais.
    const regionOverlap: string[] = [];
    const header = document.querySelector("header");
    const aside = document.querySelector("aside");
    if (header && main) {
      const h = header.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      if (h.bottom > m.top + TOL) regionOverlap.push(`header.bottom ${h.bottom} > main.top ${m.top}`);
      if (aside && !isHiddenFromUser(aside)) {
        const s = aside.getBoundingClientRect();
        if (s.right > m.left + TOL) regionOverlap.push(`aside.right ${s.right} > main.left ${m.left}`);
        if (s.right > h.left + TOL) regionOverlap.push(`aside.right ${s.right} > header.left ${h.left}`);
      }
      if (m.width < Math.min(vw, 280)) regionOverlap.push(`main muito estreito: ${m.width}px`);
    }

    // 6) Diálogos.
    const dialogIssues: string[] = [];
    for (const dialog of Array.from(document.querySelectorAll("[role='dialog']"))) {
      const r = dialog.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < -TOL || r.right > vw + TOL || r.top < -TOL || r.bottom > vh + TOL) {
        dialogIssues.push(
          `${describe(dialog)} fora da tela: ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} (vw=${vw}, vh=${vh})`,
        );
      }
      const el = dialog as HTMLElement;
      const oy = getComputedStyle(el).overflowY;
      if (el.scrollHeight > el.clientHeight + TOL && oy !== "auto" && oy !== "scroll") {
        dialogIssues.push(`${describe(dialog)} tem conteúdo cortado sem rolagem`);
      }
    }

    return {
      viewport: { width: vw, height: vh },
      docScrollWidth: document.documentElement.scrollWidth,
      mainOverflowX,
      outOfViewport: Array.from(new Set(outOfViewport)).slice(0, 20),
      smallTargets,
      overlapping,
      tinyText: Array.from(new Set(tinyText)).slice(0, 20),
      regionOverlap,
      dialogIssues,
    };
  });
}
