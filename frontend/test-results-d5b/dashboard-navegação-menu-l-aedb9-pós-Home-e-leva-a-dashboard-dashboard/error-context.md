# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard.spec.ts >> navegação >> menu lateral tem Dashboard logo após Home e leva a /dashboard
- Location: e2e\dashboard.spec.ts:215:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/dashboard$/
Received string:  "http://localhost:3198/"
Timeout: 15000ms

Call log:
  - Expect "toHaveURL" with timeout 15000ms
    33 × locator resolved to <html lang="pt-BR" data-theme="dark" data-font-scale="100" data-density="comfortable" class="__variable_8adcd2 __variable_46451f">…</html>
       - unexpected value "http://localhost:3198/"

```

```yaml
- link "Pular para o conteúdo":
  - /url: "#conteudo"
- complementary:
  - text: SISPAT-AGU
  - button "Recolher menu lateral" [expanded]
  - navigation "Navegação principal":
    - list:
      - listitem:
        - link "Home":
          - /url: /
      - listitem:
        - link "Dashboard":
          - /url: /dashboard
      - listitem:
        - link "Patrimônios":
          - /url: /patrimonios
      - listitem:
        - link "Unidades":
          - /url: /unidades
      - listitem:
        - link "Salas e Localizações":
          - /url: /salas-localizacoes
      - listitem:
        - link "Responsáveis":
          - /url: /responsaveis
      - listitem:
        - link "Inventários":
          - /url: /inventarios
      - listitem:
        - link "Movimentações":
          - /url: /movimentacoes
      - listitem:
        - link "Relatórios":
          - /url: /relatorios
      - listitem:
        - link "Importações":
          - /url: /importacoes
      - listitem:
        - button "Configurações"
- banner:
  - navigation "Trilha de navegação": Home
  - search:
    - searchbox "Busca global"
  - link "Meu perfil (Pessoa Sintética)":
    - /url: /configuracoes/perfil
  - button "Sair do sistema": Sair
- main:
  - text: Início
  - heading "SISPAT-AGU" [level=1]
  - paragraph: Sistema de Gestão Patrimonial da AGU — unidade Palmas/TO.
  - link "Abrir o Dashboard":
    - /url: /dashboard
  - region "Alertas patrimoniais":
    - heading "Alertas patrimoniais" [level=2]
    - text: Atualizado em 15/10/2026, 12:00
    - list "Lista de alertas patrimoniais":
      - listitem:
        - text: Crítico
        - heading "Patrimônio duplicado" [level=3]
        - paragraph: Números patrimoniais sintéticos repetidos entre bens ativos.
        - paragraph: 7 ocorrências
      - listitem:
        - text: Atenção
        - heading "Bens sem responsável" [level=3]
        - paragraph: Bens ativos sem responsável definido.
        - paragraph: 1234 ocorrências
      - listitem:
        - text: Informação
        - heading "Divergências do Google Sheets" [level=3]
        - paragraph: Conflitos de sincronização pendentes de revisão.
        - paragraph: 0 ocorrências
  - region "Insights de IA":
    - heading "Insights de IA" [level=2]
    - text: Atualizado em 15/10/2026, 12:00
    - paragraph: Gerado por IA — pode conter erros
    - heading "Prioridade dos alertas" [level=3]
    - heading "Priorize os duplicados" [level=4]
    - paragraph: Resolva primeiro o alerta de patrimônio duplicado. Depois trate os bens sem responsável.
    - heading "Resumo executivo" [level=3]
    - heading "Resumo da semana" [level=4]
    - paragraph: Panorama sintético do patrimônio da unidade.
    - heading "Sugestões de qualidade de dados" [level=3]
    - heading "Padronizar descrições" [level=4]
    - paragraph: Sugestão sintética para revisão humana.
  - region "Pergunte ao SISPAT":
    - heading "Pergunte ao SISPAT" [level=2]
    - paragraph: Gerado por IA — pode conter erros
    - text: Sua pergunta
    - textbox "Sua pergunta":
      - /placeholder: "Ex.: quantos bens estão sem responsável?"
    - text: 0/500 caracteres
    - button "Enviar pergunta" [disabled]
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  121 |     await expect(lineTable.getByRole("row", { name: /jul.*0/i })).toHaveCount(1);
  122 | 
  123 |     // Seleção por teclado na legenda da pizza (aria-pressed).
  124 |     const pick = donut.getByRole("button", { name: /Nao localizado/ });
  125 |     await pick.focus();
  126 |     await page.keyboard.press("Enter");
  127 |     await expect(pick).toHaveAttribute("aria-pressed", "true");
  128 |   });
  129 | 
  130 |   test("tabela de detalhamento: linhas por unidade e linha de total", async ({ page }) => {
  131 |     await open(page, "/dashboard");
  132 |     await expectDashboardLoaded(page);
  133 |     const table = page.getByRole("table", { name: "Detalhamento de bens por unidade e tipo" });
  134 |     await expect(table.getByRole("columnheader", { name: "Unidade" })).toBeVisible();
  135 |     await expect(table.getByRole("columnheader", { name: "Outros (2)" })).toBeVisible();
  136 |     await expect(table.locator("tbody th[scope=row]")).toHaveCount(3);
  137 |     const total = table.locator("tfoot tr[data-unit-total]");
  138 |     await expect(total).toContainText("Total");
  139 |     await expect(total).toContainText(/1\.?234/); // 700 + 400 + 134
  140 |     await expect(total).toContainText("660"); // mobiliário
  141 |   });
  142 | 
  143 |   test("nomes vindos do backend são texto puro (sem HTML/XSS)", async ({ page }) => {
  144 |     const rows = defaultDashboard()["por-unidade"];
  145 |     rows[0]!.unidade = `Unid ${XSS_IMG}`;
  146 |     await open(page, "/dashboard", { role: "USER", dashboard: { "por-unidade": rows } });
  147 |     await expectDashboardLoaded(page);
  148 |     await expect(page.getByRole("table", { name: /Detalhamento/ }).getByText(`Unid ${XSS_IMG}`)).toBeVisible();
  149 |     expect(await page.locator("main img").count()).toBe(0);
  150 |     expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  151 |   });
  152 | 
  153 |   test("sem bens: estados vazios honestos, sem gráficos nem números de exemplo", async ({ page }) => {
  154 |     await open(page, "/dashboard", { role: "RH", dashboard: emptyDashboard(), dashboardTech: emptyTech() });
  155 |     await expect(page.locator("[data-dashboard-empty]")).toHaveCount(EMPTY_BLOCKS, { timeout: 15_000 });
  156 |     await expect(block(page, "por-unidade")).toContainText("Nenhum bem cadastrado");
  157 |     await expect(block(page, "por-situacao")).toContainText("Nenhum bem para classificar");
  158 |     await expect(block(page, "aquisicoes-mensais")).toContainText("Nenhuma aquisição no período");
  159 |     await expect(block(page, "por-vinculo")).toContainText("Nenhum bem para classificar");
  160 |     // Pendências e inventário: zeros REAIS do backend (cartões, sem gráfico).
  161 |     await expect(block(page, "pendencias-cadastro").locator("[data-stat-card=sem-sala]")).toContainText("0");
  162 |     await expect(block(page, "inventario").locator("[data-stat-card=conferidos]")).toContainText("0");
  163 |     await expect(page.locator("[data-chart-surface]")).toHaveCount(0);
  164 |     await expect(page.locator("figure")).toHaveCount(0);
  165 |     // KPIs reais (zeros do backend) continuam exibidos; sem variação.
  166 |     await expect(block(page, "indicadores").locator("[data-stat-card=total-bens]")).toContainText("0");
  167 |     await expect(page.locator("[data-stat-delta]")).toHaveCount(0);
  168 |   });
  169 | 
  170 |   test("erro em um bloco não derruba os outros; nova tentativa recupera", async ({ page }) => {
  171 |     const state = await open(page, "/dashboard", { role: "USER", dashboardStatus: { "por-situacao": 500 } });
  172 |     const failed = block(page, "por-situacao");
  173 |     const retry = failed.getByRole("button", { name: "Tentar novamente" });
  174 |     await expect(retry).toBeVisible({ timeout: 20_000 });
  175 |     await expect(failed).not.toContainText("SISPAT_BACKEND_MSG");
  176 |     await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
  177 |     await expect(block(page, "por-unidade").locator("figure")).toBeVisible({ timeout: 20_000 });
  178 | 
  179 |     state.dashboardStatus = {};
  180 |     await retry.click();
  181 |     await expect(failed.locator("figure")).toBeVisible({ timeout: 20_000 });
  182 |     await expect(failed.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0);
  183 |   });
  184 | 
  185 |   test("resposta fora da allowlist é rejeitada (valor_total numérico => erro)", async ({ page }) => {
  186 |     const resumo = { ...defaultDashboard().resumo, valor_total: 999999 };
  187 |     await open(page, "/dashboard", { role: "USER", dashboard: { resumo } });
  188 |     const kpis = block(page, "indicadores");
  189 |     await expect(kpis.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 20_000 });
  190 |     await expect(kpis.locator("[data-stat-card]")).toHaveCount(0);
  191 |     await expect(page.locator("main")).not.toContainText("999");
  192 |   });
  193 | 
  194 |   test("KPIs em 2 colunas no celular e 5 (uma linha) no desktop largo", async ({ page }) => {
  195 |     await page.setViewportSize({ width: 375, height: 800 });
  196 |     await open(page, "/dashboard");
  197 |     const cards = block(page, "indicadores").locator("[data-stat-card]");
  198 |     await expect(cards).toHaveCount(KPI_CARDS);
  199 |     const distinctTops = async () =>
  200 |       new Set(await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))).size;
  201 |     expect(await distinctTops()).toBe(3);
  202 |     await page.setViewportSize({ width: 1366, height: 800 });
  203 |     await expect.poll(distinctTops).toBe(1);
  204 |   });
  205 | 
  206 |   test("reduced motion: valores finais exatos", async ({ page }) => {
  207 |     await page.emulateMedia({ reducedMotion: "reduce" });
  208 |     await open(page, "/dashboard");
  209 |     await expectDashboardLoaded(page);
  210 |     await expect(block(page, "indicadores").locator("[data-stat-card=total-bens]")).toContainText(/1\.?234/);
  211 |   });
  212 | });
  213 | 
  214 | test.describe("navegação", () => {
  215 |   test("menu lateral tem Dashboard logo após Home e leva a /dashboard", async ({ page }) => {
  216 |     await open(page, "/", { role: "USER" });
  217 |     const nav = page.getByRole("navigation", { name: "Navegação principal", exact: true });
  218 |     const hrefs = await nav.locator("a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  219 |     expect(hrefs.slice(0, 2)).toEqual(["/", "/dashboard"]);
  220 |     await nav.getByRole("link", { name: "Dashboard" }).click();
> 221 |     await expect(page).toHaveURL(/\/dashboard$/);
      |                        ^ Error: expect(page).toHaveURL(expected) failed
  222 |     await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  223 |     await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  224 |   });
  225 | 
  226 |   test("atalho da Home linka para /dashboard", async ({ page }) => {
  227 |     await open(page, "/", { role: "USER" });
  228 |     await page.getByRole("link", { name: "Abrir o Dashboard" }).click();
  229 |     await expect(page).toHaveURL(/\/dashboard$/, { timeout: 45_000 }); // 1ª compilação do `next dev`
  230 |   });
  231 | 
  232 |   for (const role of ["ADM", "USER", "RH"] as const) {
  233 |     test(`${role}: acessa /dashboard`, async ({ page }) => {
  234 |       await open(page, "/dashboard", { role });
  235 |       await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  236 |       await expect(block(page, "indicadores").locator("[data-stat-card]")).toHaveCount(KPI_CARDS);
  237 |     });
  238 |   }
  239 | });
  240 | 
  241 | test.describe("relatório imprimível", () => {
  242 |   test("mesma composição, botão Imprimir chama window.print", async ({ page }) => {
  243 |     await page.addInitScript(() => {
  244 |       (window as unknown as { __printed: number }).__printed = 0;
  245 |       window.print = () => {
  246 |         (window as unknown as { __printed: number }).__printed += 1;
  247 |       };
  248 |     });
  249 |     await open(page, "/dashboard/relatorio", { role: "USER" });
  250 |     await expect(page.getByRole("heading", { level: 1, name: "Relatório patrimonial" })).toBeVisible();
  251 |     await expectDashboardLoaded(page);
  252 |     await expect(page.locator("[data-report-sheet]")).toContainText(/Emitido em/);
  253 |     await page.getByRole("button", { name: "Imprimir / Salvar PDF" }).click();
  254 |     expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  255 |   });
  256 | 
  257 |   test("em mídia print: sem sidebar/header/botões, sem rolagem interna e fundo branco", async ({ page }) => {
  258 |     await open(page, "/dashboard/relatorio", { role: "USER" });
  259 |     await expectDashboardLoaded(page);
  260 |     await page.emulateMedia({ media: "print" });
  261 |     await expect(page.getByRole("navigation", { name: "Navegação principal", exact: true })).toBeHidden();
  262 |     await expect(page.getByRole("banner")).toBeHidden();
  263 |     await expect(page.getByRole("button", { name: "Imprimir / Salvar PDF" })).toBeHidden();
  264 |     await expect(page.getByRole("link", { name: "Voltar ao dashboard" })).toBeHidden();
  265 |     const info = await page.evaluate(() => {
  266 |       const main = document.getElementById("conteudo")!;
  267 |       const sheet = document.querySelector("[data-report-sheet]")!;
  268 |       return {
  269 |         mainOverflow: getComputedStyle(main).overflowY,
  270 |         sheetBg: getComputedStyle(sheet).backgroundColor,
  271 |         bodyBg: getComputedStyle(document.body).backgroundColor,
  272 |         docScrollWidth: document.documentElement.scrollWidth,
  273 |         innerWidth: window.innerWidth,
  274 |         blockBreak: Array.from(document.querySelectorAll("[data-dashboard-block]")).every(
  275 |           (el) => getComputedStyle(el).breakInside === "avoid",
  276 |         ),
  277 |       };
  278 |     });
  279 |     expect(info.mainOverflow).toBe("visible");
  280 |     expect(info.sheetBg).toBe("rgb(255, 255, 255)");
  281 |     expect(info.bodyBg).toBe("rgb(255, 255, 255)");
  282 |     expect(info.docScrollWidth).toBeLessThanOrEqual(info.innerWidth);
  283 |     expect(info.blockBreak).toBe(true);
  284 |     // Gráficos continuam presentes no papel.
  285 |     await expect(block(page, "aquisicoes-mensais").locator("figure")).toBeVisible();
  286 |   });
  287 | });
  288 | 
```