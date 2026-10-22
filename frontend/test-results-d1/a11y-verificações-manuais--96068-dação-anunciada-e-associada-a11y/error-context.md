# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: a11y.spec.ts >> verificações manuais automatizadas >> ativar conta: validação anunciada e associada
- Location: e2e\a11y.spec.ts:234:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.fill: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByLabel('Nova senha')

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - link "Pular para o conteúdo" [ref=e2] [cursor=pointer]:
    - /url: "#conteudo"
  - generic [ref=e3]:
    - banner [ref=e4]:
      - img "Logomarca da Advocacia-Geral da União" [ref=e6]
      - paragraph [ref=e7]: Unidade Estadual de Administração em Tocantins
      - generic [ref=e8]: SISPAT-AGU
    - main [ref=e9]:
      - generic [ref=e12]:
        - heading "Ativar conta" [level=1] [ref=e14]
        - generic [ref=e15]:
          - heading "Link de convite inválido" [active] [level=2] [ref=e16]
          - alert [ref=e17]:
            - generic [ref=e18]: Este link de convite é inválido ou já expirou. Solicite um novo convite a um administrador.
          - link "Ir para o login" [ref=e19] [cursor=pointer]:
            - /url: /login
    - contentinfo [ref=e20]:
      - paragraph [ref=e21]: Sistema de Gestão Patrimonial — AGU, Palmas/TO
      - paragraph [ref=e22]: Acesso apenas por convite. Em caso de dúvida, contate o administrador da sua unidade.
      - paragraph [ref=e23]: © 2026 AGU
  - button "Open Next.js Dev Tools" [ref=e29] [cursor=pointer]
  - alert [ref=e33]
```

# Test source

```ts
  139 |   });
  140 | 
  141 |   test("modal de convite: foco preso, Esc fecha e devolve o foco", async ({ page }) => {
  142 |     await installMocks(page, { role: "ADM" });
  143 |     await seedSession(page, { role: "ADM" });
  144 |     await page.goto("/administracao/usuarios");
  145 |     await waitForHydration(page);
  146 |     const trigger = page.getByRole("button", { name: "Convidar Usuário" });
  147 |     await trigger.click();
  148 |     const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
  149 |     await expect(dialog).toBeVisible();
  150 |     // Foco inicial dentro do diálogo e preso durante 20 Tabs / Shift+Tabs.
  151 |     for (const key of ["Tab", "Shift+Tab"]) {
  152 |       for (let i = 0; i < 20; i++) {
  153 |         await page.keyboard.press(key);
  154 |         const inside = await page.evaluate(
  155 |           () => !!document.activeElement?.closest("[role='dialog']"),
  156 |         );
  157 |         expect(inside, `${key} #${i} saiu do diálogo`).toBeTruthy();
  158 |       }
  159 |     }
  160 |     await page.keyboard.press("Escape");
  161 |     await expect(dialog).toBeHidden();
  162 |     await expect(trigger).toBeFocused();
  163 |   });
  164 | 
  165 |   test("menu móvel: foco preso, Esc fecha e devolve o foco", async ({ page }) => {
  166 |     await page.setViewportSize({ width: 375, height: 667 });
  167 |     await installMocks(page, { role: "ADM" });
  168 |     await seedSession(page, { role: "ADM" });
  169 |     await page.goto("/");
  170 |     await waitForHydration(page);
  171 |     const trigger = page.getByRole("button", { name: "Abrir menu de navegação" });
  172 |     await trigger.click();
  173 |     const drawer = page.getByRole("dialog", { name: "SISPAT-AGU" });
  174 |     await expect(drawer).toBeVisible();
  175 |     for (let i = 0; i < 20; i++) {
  176 |       await page.keyboard.press("Tab");
  177 |       expect(
  178 |         await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']")),
  179 |       ).toBeTruthy();
  180 |     }
  181 |     await page.keyboard.press("Escape");
  182 |     await expect(drawer).toBeHidden();
  183 |     await expect(trigger).toBeFocused();
  184 |   });
  185 | 
  186 |   test("modal de confirmação da importação: Esc fecha", async ({ page }) => {
  187 |     const screen = SCREENS.find((s) => s.id === "importacao-confirmar")!;
  188 |     await openScreen(page, screen);
  189 |     const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
  190 |     await expect(dialog.getByRole("button", { name: "Cancelar" })).toBeVisible();
  191 |     await page.keyboard.press("Escape");
  192 |     await expect(dialog).toBeHidden();
  193 |     await expect(page.getByRole("button", { name: "Confirmar Importação" })).toBeFocused();
  194 |   });
  195 | 
  196 |   // Um teste por tela (antes: loop único de ~6 min isolado e >20 min sob carga,
  197 |   // estourando o limite). Mesmas asserções, paralelizáveis e com falha localizada.
  198 |   for (const screen of SCREENS) {
  199 |     test(`headings: ${screen.id}: um único h1 e sem saltos de nível`, async ({ page }) => {
  200 |       test.setTimeout(120_000);
  201 |       await openScreen(page, screen);
  202 |       const levels = await page.evaluate(() =>
  203 |         Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
  204 |           .filter((h) => !h.closest("[aria-hidden='true']") && (h as HTMLElement).offsetParent !== null)
  205 |           .map((h) => Number(h.tagName[1])),
  206 |       );
  207 |       const h1Count = await page.locator("main h1").count();
  208 |       expect.soft(h1Count, `${screen.id}: h1 em <main>`).toBe(1);
  209 |       for (let i = 1; i < levels.length; i++) {
  210 |         expect.soft(levels[i]! - levels[i - 1]!, `${screen.id}: salto de heading ${levels.join(",")}`).toBeLessThanOrEqual(1);
  211 |       }
  212 |     });
  213 |   }
  214 | 
  215 |   test("login: erro anunciado (role=alert) e associado aos campos", async ({ page }) => {
  216 |     await installMocks(page);
  217 |     await page.goto("/login");
  218 |     await waitForHydration(page);
  219 |     await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
  220 |     await page.getByLabel("Senha").fill("senha-errada");
  221 |     await page.getByRole("button", { name: "Entrar" }).click();
  222 |     const alert = page.getByRole("alert").filter({ hasText: "E-mail ou senha incorretos." });
  223 |     await expect(alert).toBeVisible();
  224 |     const alertId = await alert.getAttribute("id");
  225 |     expect(alertId).toBeTruthy();
  226 |     for (const label of ["E-mail", "Senha"]) {
  227 |       const input = page.getByLabel(label);
  228 |       await expect(input).toHaveAttribute("aria-invalid", "true");
  229 |       await expect(input).toHaveAttribute("aria-describedby", new RegExp(alertId!));
  230 |       await expect(input).toHaveAccessibleDescription("E-mail ou senha incorretos.");
  231 |     }
  232 |   });
  233 | 
  234 |   test("ativar conta: validação anunciada e associada", async ({ page }) => {
  235 |     await installMocks(page, { role: "USER" });
  236 |     await seedSession(page, { role: "USER" });
  237 |     await page.goto("/ativar-conta");
  238 |     await waitForHydration(page);
> 239 |     await page.getByLabel("Nova senha").fill("12345678");
      |                                         ^ Error: locator.fill: Test timeout of 60000ms exceeded.
  240 |     await page.getByLabel("Confirmar senha").fill("87654321");
  241 |     await page.getByRole("button", { name: "Ativar conta" }).click();
  242 |     await expect(page.getByRole("alert").filter({ hasText: "As senhas não coincidem." })).toBeVisible();
  243 |     await expect(page.getByLabel("Confirmar senha")).toHaveAccessibleDescription("As senhas não coincidem.");
  244 |   });
  245 | 
  246 |   test("todos os campos têm rótulo acessível", async ({ page }) => {
  247 |     for (const id of ["login", "ativar-conta", "seguranca-ativar", "usuarios-convite", "importacao"]) {
  248 |       const fresh = await page.context().newPage();
  249 |       await openScreen(fresh, SCREENS.find((s) => s.id === id)!);
  250 |       const unlabeled = await fresh.evaluate(() =>
  251 |         Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
  252 |           .filter((el) => !el.closest("[aria-hidden='true']"))
  253 |           .filter((el) => {
  254 |             const input = el as HTMLInputElement;
  255 |             const byLabel = input.labels && input.labels.length > 0;
  256 |             return !byLabel && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby");
  257 |           })
  258 |           .map((el) => el.outerHTML.slice(0, 80)),
  259 |       );
  260 |       expect.soft(unlabeled, `${id}: campos sem rótulo`).toEqual([]);
  261 |       await fresh.close();
  262 |     }
  263 |   });
  264 | 
  265 |   test("fonte Geist/Geist Mono do DESIGN.md é de fato aplicada", async ({ page }) => {
  266 |     await installMocks(page);
  267 |     await page.goto("/login");
  268 |     await waitForHydration(page);
  269 |     const fonts = await page.evaluate(async () => {
  270 |       await document.fonts.ready;
  271 |       return {
  272 |         heading: getComputedStyle(document.querySelector("h1")!).fontFamily,
  273 |         eyebrow: getComputedStyle(document.querySelector(".text-eyebrow")!).fontFamily,
  274 |       };
  275 |     });
  276 |     expect(fonts.heading).toMatch(/^'?GeistSans/);
  277 |     expect(fonts.eyebrow).toMatch(/^'?GeistMono/);
  278 |   });
  279 | });
  280 | 
  281 | // -----------------------------------------------------------------------------
  282 | // Contraste dos pares de tokens do DESIGN.md efetivamente usados na UI.
  283 | // -----------------------------------------------------------------------------
  284 | 
  285 | function luminance(hex: string): number {
  286 |   const [r, g, b] = [1, 3, 5].map((i) => {
  287 |     const c = parseInt(hex.slice(i, i + 2), 16) / 255;
  288 |     return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  289 |   }) as [number, number, number];
  290 |   return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  291 | }
  292 | 
  293 | function contrast(fg: string, bg: string): number {
  294 |   const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  295 |   return (a + 0.05) / (b + 0.05);
  296 | }
  297 | 
  298 | const T = {
  299 |   canvas: "#101010",
  300 |   carbon: "#1d1a18",
  301 |   ash: "#3d3a39",
  302 |   graphite: "#4d4947",
  303 |   granite: "#8a8380",
  304 |   stone: "#b8b3b0",
  305 |   bone: "#eeeeee",
  306 |   chalk: "#fafafa",
  307 |   orange: "#ee6018",
  308 |   green: "#a0ca92",
  309 | };
  310 | 
  311 | test.describe("contraste dos tokens (WCAG 1.4.3 / 1.4.11)", () => {
  312 |   const usedTextPairs: [string, string, string][] = [
  313 |     ["bone sobre canvas (texto principal)", T.bone, T.canvas],
  314 |     ["warm-granite sobre canvas (texto secundário)", T.granite, T.canvas],
  315 |     ["warm-granite sobre carbon-lift (placeholder/sidebar)", T.granite, T.carbon],
  316 |     ["pale-stone sobre canvas (eyebrows)", T.stone, T.canvas],
  317 |     ["pale-stone sobre carbon-lift", T.stone, T.carbon],
  318 |     ["signal-orange sobre canvas (erros)", T.orange, T.canvas],
  319 |     ["signal-orange sobre carbon-lift (erros em card)", T.orange, T.carbon],
  320 |     ["metric-green sobre canvas (sucesso)", T.green, T.canvas],
  321 |     ["metric-green sobre carbon-lift", T.green, T.carbon],
  322 |     ["obsidian sobre bone (texto em diálogo)", T.canvas, T.bone],
  323 |     ["graphite-mid sobre bone (descrição/rótulos em diálogo)", T.graphite, T.bone],
  324 |     ["obsidian sobre chalk (botão light)", T.canvas, T.chalk],
  325 |     ["bone sobre carbon-lift (botão default/inputs)", T.bone, T.carbon],
  326 |   ];
  327 |   for (const [label, fg, bg] of usedTextPairs) {
  328 |     test(`${label} >= 4.5:1`, () => {
  329 |       expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  330 |     });
  331 |   }
  332 | 
  333 |   test("pares PROIBIDOS para texto (documentados): laranja/verde/granite sobre bone", () => {
  334 |     // Estes pares NÃO podem ser usados para texto — por isso FormMessage
  335 |     // surface="light" e Button variant="outlineOnLight" existem.
  336 |     expect(contrast(T.orange, T.bone)).toBeLessThan(4.5);
  337 |     expect(contrast(T.green, T.bone)).toBeLessThan(4.5);
  338 |     expect(contrast(T.granite, T.bone)).toBeLessThan(4.5);
  339 |   });
```