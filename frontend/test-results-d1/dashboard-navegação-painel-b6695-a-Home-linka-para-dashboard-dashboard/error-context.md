# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard.spec.ts >> navegação >> painel vazio da Home linka para /dashboard
- Location: e2e\dashboard.spec.ts:226:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('link', { name: /Ver o dashboard completo/ })

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - link "Pular para o conteúdo" [ref=e2] [cursor=pointer]:
    - /url: "#conteudo"
  - generic [ref=e3]:
    - complementary [ref=e4]:
      - generic [ref=e5]:
        - generic [ref=e6]: SISPAT-AGU
        - button "Recolher menu lateral" [expanded] [ref=e7] [cursor=pointer]
      - navigation "Navegação principal" [ref=e11]:
        - list [ref=e13]:
          - listitem [ref=e14]:
            - link "Home" [ref=e15] [cursor=pointer]:
              - /url: /
          - listitem [ref=e20]:
            - link "Dashboard" [ref=e21] [cursor=pointer]:
              - /url: /dashboard
          - listitem [ref=e28]:
            - link "Patrimônios" [ref=e29] [cursor=pointer]:
              - /url: /patrimonios
          - listitem [ref=e35]:
            - link "Unidades" [ref=e36] [cursor=pointer]:
              - /url: /unidades
          - listitem [ref=e42]:
            - link "Salas e Localizações" [ref=e43] [cursor=pointer]:
              - /url: /salas-localizacoes
          - listitem [ref=e48]:
            - link "Responsáveis" [ref=e49] [cursor=pointer]:
              - /url: /responsaveis
          - listitem [ref=e56]:
            - link "Inventários" [ref=e57] [cursor=pointer]:
              - /url: /inventarios
          - listitem [ref=e62]:
            - link "Movimentações" [ref=e63] [cursor=pointer]:
              - /url: /movimentacoes
          - listitem [ref=e68]:
            - link "Relatórios" [ref=e69] [cursor=pointer]:
              - /url: /relatorios
          - listitem [ref=e73]:
            - link "Importações" [ref=e74] [cursor=pointer]:
              - /url: /importacoes
          - listitem [ref=e79]:
            - button "Configurações" [ref=e80] [cursor=pointer]
    - generic [ref=e87]:
      - banner [ref=e88]:
        - navigation "Trilha de navegação" [ref=e90]:
          - generic [ref=e91]: Home
        - generic [ref=e93]:
          - search [ref=e94]:
            - searchbox "Busca global" [ref=e95]
          - link "Meu perfil (Pessoa Sintética)" [ref=e96] [cursor=pointer]:
            - /url: /configuracoes/perfil
            - generic [aria-hidden] [ref=e97]: PS
          - button "Sair do sistema" [ref=e98] [cursor=pointer]:
            - generic [ref=e99]: Sair
      - main [ref=e100]:
        - generic [ref=e102]:
          - generic [ref=e103]:
            - generic [ref=e104]: Início
            - generic [ref=e107]:
              - heading "SISPAT-AGU" [level=1] [ref=e108]
              - paragraph [ref=e109]: Sistema de Gestão Patrimonial da AGU — unidade Palmas/TO.
            - link "Abrir o Dashboard" [ref=e111] [cursor=pointer]:
              - /url: /dashboard
          - region [ref=e112]:
            - generic [ref=e113]:
              - heading "Alertas patrimoniais" [level=2] [ref=e114]
              - generic [ref=e115]: Atualizado em 15/10/2026, 12:00
            - list "Lista de alertas patrimoniais" [ref=e116]:
              - listitem [ref=e117]:
                - generic [ref=e118]:
                  - generic [ref=e119]: Crítico
                  - heading "Patrimônio duplicado" [level=3] [ref=e122]
                  - paragraph [ref=e123]: Números patrimoniais sintéticos repetidos entre bens ativos.
                - paragraph [ref=e124]:
                  - generic [ref=e125]: "7"
                  - generic [ref=e126]: ocorrências
              - listitem [ref=e127]:
                - generic [ref=e128]:
                  - generic [ref=e129]: Atenção
                  - heading "Bens sem responsável" [level=3] [ref=e132]
                  - paragraph [ref=e133]: Bens ativos sem responsável definido.
                - paragraph [ref=e134]:
                  - generic [ref=e135]: "1234"
                  - generic [ref=e136]: ocorrências
              - listitem [ref=e137]:
                - generic [ref=e138]:
                  - generic [ref=e139]: Informação
                  - heading "Divergências do Google Sheets" [level=3] [ref=e142]
                  - paragraph [ref=e143]: Conflitos de sincronização pendentes de revisão.
                - paragraph [ref=e144]:
                  - generic [ref=e145]: "0"
                  - generic [ref=e146]: ocorrências
          - region [ref=e147]:
            - generic [ref=e148]:
              - heading "Insights de IA" [level=2] [ref=e149]
              - generic [ref=e150]: Atualizado em 15/10/2026, 12:00
            - generic [ref=e151]:
              - paragraph [ref=e153]: Gerado por IA — pode conter erros
              - generic [ref=e157]:
                - generic [ref=e158]:
                  - heading "Prioridade dos alertas" [level=3] [ref=e159]
                  - generic [ref=e160]:
                    - heading "Priorize os duplicados" [level=4] [ref=e161]
                    - paragraph [ref=e162]: Resolva primeiro o alerta de patrimônio duplicado. Depois trate os bens sem responsável.
                - generic [ref=e163]:
                  - heading "Resumo executivo" [level=3] [ref=e164]
                  - generic [ref=e165]:
                    - heading "Resumo da semana" [level=4] [ref=e166]
                    - paragraph [ref=e167]: Panorama sintético do patrimônio da unidade.
                - generic [ref=e168]:
                  - heading "Sugestões de qualidade de dados" [level=3] [ref=e169]
                  - generic [ref=e170]:
                    - heading "Padronizar descrições" [level=4] [ref=e171]
                    - paragraph [ref=e172]: Sugestão sintética para revisão humana.
          - region [ref=e173]:
            - heading "Pergunte ao SISPAT" [level=2] [ref=e175]
            - generic [ref=e176]:
              - paragraph [ref=e177]: Gerado por IA — pode conter erros
              - generic [ref=e181]:
                - generic [ref=e182]: Sua pergunta
                - textbox "Sua pergunta" [ref=e183]:
                  - /placeholder: "Ex.: quantos bens estão sem responsável?"
                - generic [ref=e184]:
                  - generic [ref=e185]: 0/500 caracteres
                  - button "Enviar pergunta" [disabled]
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e191] [cursor=pointer]
  - alert [ref=e195]
```

# Test source

```ts
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
  221 |     await expect(page).toHaveURL(/\/dashboard$/);
  222 |     await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  223 |     await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  224 |   });
  225 | 
  226 |   test("painel vazio da Home linka para /dashboard", async ({ page }) => {
  227 |     await open(page, "/", { role: "USER" });
> 228 |     await page.getByRole("link", { name: /Ver o dashboard completo/ }).click();
      |                                                                        ^ Error: locator.click: Test timeout of 60000ms exceeded.
  229 |     await expect(page).toHaveURL(/\/dashboard$/);
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