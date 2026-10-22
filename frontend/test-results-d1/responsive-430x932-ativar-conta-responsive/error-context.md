# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: responsive.spec.ts >> 430x932 >> ativar-conta
- Location: e2e\responsive.spec.ts:25:11

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'Ativar conta' })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('button', { name: 'Ativar conta' }) with timeout 15000ms
  - waiting for getByRole('button', { name: 'Ativar conta' })

```

```yaml
- link "Pular para o conteúdo":
  - /url: "#conteudo"
- banner:
  - img "Logomarca da Advocacia-Geral da União"
  - paragraph: Unidade Estadual de Administração em Tocantins
  - text: SISPAT-AGU
- main:
  - heading "Ativar conta" [level=1]
  - heading "Link de convite inválido" [level=2]
  - alert: Este link de convite é inválido ou já expirou. Solicite um novo convite a um administrador.
  - link "Ir para o login":
    - /url: /login
- contentinfo:
  - paragraph: Sistema de Gestão Patrimonial — AGU, Palmas/TO
  - paragraph: Acesso apenas por convite. Em caso de dúvida, contate o administrador da sua unidade.
  - paragraph: © 2026 AGU
- alert
```

# Test source

```ts
  231 |   path: "/relatorios",
  232 |   session: { role },
  233 |   prepare: async (page: Page) => {
  234 |     await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
  235 |     await expect(page.getByTestId("report-form")).toBeVisible();
  236 |     await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeVisible();
  237 |   },
  238 | }));
  239 | 
  240 | const REPORT_ERROR_SCREENS: ScreenDef[] = [
  241 |   {
  242 |     id: "relatorios-erro",
  243 |     title: "Relatórios — erro ao carregar o catálogo",
  244 |     path: "/relatorios",
  245 |     session: { role: "USER", reports: { catalogStatus: 500 } },
  246 |     prepare: async (page) => {
  247 |       await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
  248 |     },
  249 |   },
  250 |   {
  251 |     id: "relatorios-limite",
  252 |     title: "Relatórios — exportação acima do limite (413)",
  253 |     path: "/relatorios",
  254 |     session: { role: "USER" },
  255 |     prepare: async (page) => {
  256 |       await page.getByLabel("Busca (número ou descrição)").fill("limite");
  257 |       await page.getByRole("button", { name: "Exportar CSV" }).click();
  258 |       await expect(page.getByTestId("report-outcome")).toContainText("Refine os filtros");
  259 |       // Volta ao topo: o cabeçalho fixo não deve cobrir controles rolados pelo clique.
  260 |       await page.getByRole("main").evaluate((el) => el.scrollTo(0, 0));
  261 |       await page.evaluate(() => window.scrollTo(0, 0));
  262 |     },
  263 |   },
  264 |   {
  265 |     id: "relatorios-mfa",
  266 |     title: "Relatórios — ADM sem MFA (AAL1)",
  267 |     path: "/relatorios",
  268 |     session: { role: "ADM", aal: "aal1" },
  269 |     prepare: async (page) => {
  270 |       await expect(page.getByTestId("access-restricted")).toBeVisible();
  271 |     },
  272 |   },
  273 | ];
  274 | 
  275 | /** Módulo administrativo aberto por quem não é ADM: nega por padrão. */
  276 | const MODULE_DENIED_SCREEN: ScreenDef = {
  277 |   id: "modulo-admin-negado",
  278 |   title: "Auditoria — acesso restrito (USER)",
  279 |   path: "/administracao/auditoria",
  280 |   session: { role: "USER" },
  281 |   prepare: async (page) => {
  282 |     await expect(page.getByRole("heading", { level: 1, name: "Auditoria" })).toBeVisible();
  283 |     await expect(page.getByTestId("access-restricted")).toBeVisible();
  284 |     await expect(page.getByTestId("module-state-panel")).toBeHidden();
  285 |   },
  286 | };
  287 | 
  288 | export const SCREENS: ScreenDef[] = [
  289 |   {
  290 |     id: "login",
  291 |     title: "Login",
  292 |     path: "/login",
  293 |     session: null,
  294 |     prepare: async (page) => {
  295 |       await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
  296 |     },
  297 |   },
  298 |   {
  299 |     id: "login-mfa",
  300 |     title: "Login — desafio MFA",
  301 |     path: "/login",
  302 |     session: null,
  303 |     prepare: async (page) => {
  304 |       await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
  305 |       await page.getByLabel("Senha").fill("senha-sintetica-123");
  306 |       await page.getByRole("button", { name: "Entrar" }).click();
  307 |       await expect(page.getByRole("heading", { level: 1, name: "Verificação em duas etapas" })).toBeVisible();
  308 |     },
  309 |   },
  310 |   {
  311 |     id: "login-enroll",
  312 |     title: "Login — cadastro do primeiro fator TOTP (ADM sem fator)",
  313 |     path: "/login",
  314 |     session: null,
  315 |     prepare: async (page) => {
  316 |       await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
  317 |       await page.getByLabel("Senha").fill("senha-sintetica-123");
  318 |       await page.getByRole("button", { name: "Entrar" }).click();
  319 |       await expect(
  320 |         page.getByRole("heading", { level: 1, name: "Ativar verificação em duas etapas" }),
  321 |       ).toBeVisible();
  322 |       await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  323 |     },
  324 |   },
  325 |   {
  326 |     id: "ativar-conta",
  327 |     title: "Ativar conta (convite/recuperação)",
  328 |     path: "/ativar-conta",
  329 |     session: { role: "USER" },
  330 |     prepare: async (page) => {
> 331 |       await expect(page.getByRole("button", { name: "Ativar conta" })).toBeVisible();
      |                                                                        ^ Error: expect(locator).toBeVisible() failed
  332 |     },
  333 |   },
  334 |   {
  335 |     id: "ativar-conta-confirmar",
  336 |     title: "Ativar conta — confirmação do convite (token_hash)",
  337 |     path: "/ativar-conta?token_hash=hash-valido-e2e&type=invite",
  338 |     session: null,
  339 |     prepare: async (page) => {
  340 |       await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
  341 |     },
  342 |   },
  343 |   {
  344 |     id: "ativar-conta-recuperacao",
  345 |     title: "Redefinir senha — nova senha (link de recuperação, type=recovery)",
  346 |     path: "/ativar-conta?token_hash=hash-valido-e2e&type=recovery",
  347 |     session: null,
  348 |     prepare: async (page) => {
  349 |       await page.getByRole("button", { name: "Continuar" }).click();
  350 |       await expect(page.getByRole("button", { name: "Redefinir senha" })).toBeVisible();
  351 |     },
  352 |   },
  353 |   {
  354 |     id: "ativar-conta-invalido",
  355 |     title: "Ativar conta — link inválido",
  356 |     path: "/ativar-conta",
  357 |     session: null,
  358 |     prepare: async (page) => {
  359 |       await expect(page.getByText("Este link de convite é inválido")).toBeVisible();
  360 |     },
  361 |   },
  362 |   {
  363 |     id: "dashboard",
  364 |     title: "Dashboard (/) — alertas com item crítico",
  365 |     path: "/",
  366 |     session: { role: "ADM" },
  367 |     prepare: async (page) => {
  368 |       await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
  369 |       await expect(page.getByRole("heading", { level: 3, name: "Patrimônio duplicado" })).toBeVisible();
  370 |       await expect(page.locator("[data-alerts-widget] [data-severity=critical]")).toContainText("Crítico");
  371 |     },
  372 |   },
  373 |   {
  374 |     id: "dashboard-alertas-vazio",
  375 |     title: "Dashboard — alertas: Nenhum alerta",
  376 |     path: "/",
  377 |     session: { role: "USER", alerts: { generated_at: "2026-10-15T15:00:00Z", items: [], unavailable: [] } },
  378 |     prepare: async (page) => {
  379 |       await expect(page.getByText("Nenhum alerta", { exact: true })).toBeVisible();
  380 |     },
  381 |   },
  382 |   {
  383 |     id: "dashboard-alertas-erro",
  384 |     title: "Dashboard — alertas: erro com nova tentativa",
  385 |     path: "/",
  386 |     session: { role: "RH", alertsStatus: 500 },
  387 |     prepare: async (page) => {
  388 |       await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
  389 |     },
  390 |   },
  391 |   {
  392 |     id: "dashboard-alertas-parcial",
  393 |     title: "Dashboard — alertas: resultado parcial (unavailable)",
  394 |     path: "/",
  395 |     session: {
  396 |       role: "USER",
  397 |       alerts: {
  398 |         generated_at: "2026-10-15T15:00:00Z",
  399 |         items: [
  400 |           { code: "no_location", severity: "warning", title: "Bens sem localização", description: "Sem sala ou local.", count: 12 },
  401 |         ],
  402 |         unavailable: ["duplicate_asset_number", "sheets_conflicts"],
  403 |       },
  404 |     },
  405 |     prepare: async (page) => {
  406 |       await expect(page.getByText(/Resultado parcial/)).toBeVisible();
  407 |       await expect(page.getByRole("heading", { level: 3, name: "Bens sem localização" })).toBeVisible();
  408 |     },
  409 |   },
  410 |   {
  411 |     id: "dashboard-ia",
  412 |     title: "Dashboard — Insights de IA e Pergunte ao SISPAT (resposta exibida)",
  413 |     path: "/",
  414 |     session: { role: "USER" },
  415 |     prepare: async (page) => {
  416 |       await expect(page.getByRole("heading", { level: 3, name: "Resumo executivo" })).toBeVisible();
  417 |       await expect(page.getByText("Gerado por IA — pode conter erros").first()).toBeVisible();
  418 |       await page.getByLabel("Sua pergunta").fill("Quantos bens estão sem responsável?");
  419 |       await page.getByRole("button", { name: "Enviar pergunta" }).click();
  420 |       await expect(page.locator("[data-ask-answer]")).toContainText("1234");
  421 |     },
  422 |   },
  423 |   {
  424 |     id: "dashboard-ia-indisponivel",
  425 |     title: "Dashboard — IA indisponível (estado neutro)",
  426 |     path: "/",
  427 |     session: { role: "RH", aiInsights: { status: "unavailable", generated_at: null, items: [] } },
  428 |     prepare: async (page) => {
  429 |       await expect(page.getByText("Insights de IA indisponíveis")).toBeVisible();
  430 |     },
  431 |   },
```