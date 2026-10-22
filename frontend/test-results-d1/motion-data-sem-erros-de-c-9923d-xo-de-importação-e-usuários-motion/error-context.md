# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: motion-data.spec.ts >> sem erros de console/hidratação no fluxo de importação e usuários
- Location: e2e\motion-data.spec.ts:375:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Página 1 de 1 — 8 item(ns)')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('Página 1 de 1 — 8 item(ns)') with timeout 15000ms
  - waiting for getByText('Página 1 de 1 — 8 item(ns)')

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
        - button "Administração" [expanded]
        - list:
          - listitem:
            - link "Usuários":
              - /url: /administracao/usuarios
          - listitem:
            - link "Cadastro de Unidades":
              - /url: /administracao/unidades
          - listitem:
            - link "Cadastro de Salas":
              - /url: /administracao/salas
          - listitem:
            - link "Cadastro de Responsáveis":
              - /url: /administracao/responsaveis
          - listitem:
            - link "Perfis e Permissões":
              - /url: /administracao/perfis-permissoes
          - listitem:
            - link "Vínculos de Unidades":
              - /url: /administracao/vinculos-unidades
          - listitem:
            - link "Auditoria":
              - /url: /administracao/auditoria
          - listitem:
            - link "Integrações Em breve":
              - /url: /administracao/integracoes
          - listitem:
            - link "Importação de Dados → Google Sheets":
              - /url: /administracao/importacao/google-sheets
          - listitem:
            - link "Importação de Dados → Cadastros de apoio":
              - /url: /administracao/importacao/cadastros
          - listitem:
            - link "Configurações do Sistema Em breve":
              - /url: /administracao/configuracoes-sistema
      - listitem:
        - button "Configurações"
- banner:
  - navigation "Trilha de navegação":
    - link "Home":
      - /url: /
    - link "Administração":
      - /url: /administracao
    - text: Importação de Dados → Google Sheets
  - search:
    - searchbox "Busca global"
  - link "Meu perfil (Pessoa Sintética)":
    - /url: /configuracoes/perfil
  - button "Sair do sistema": Sair
- main:
  - text: Administração / Importação de Dados
  - heading "Google Sheets" [level=1]
  - paragraph: Pré-visualize os registros da planilha de origem e revise cada item antes de confirmar a importação para o inventário.
  - button "Pré-visualizar Importação"
  - button "Confirmar Importação"
  - status: "Requisição: Prévia pronta"
  - group "Resumo quantitativo da pré-visualização": Total 8 Novo 3 Existente 2 Duplicado 1 Inválido 1 Conflitante 1
  - status:
    - paragraph: 3 registro(s) exigem revisão na planilha de origem e não podem ser selecionados.
    - list:
      - listitem: "Duplicado: 1"
      - listitem: "Inválido: 1"
      - listitem: "Conflitante: 1"
  - region "Pendências de vínculo (12)":
    - heading "Pendências de vínculo (12)" [level=2]
    - paragraph: "Linhas cuja unidade, sala ou pessoa não foi encontrada nos cadastros. Não bloqueiam a confirmação: o bem é importado sem o vínculo ausente."
    - list:
      - listitem: "Unidade sem alias (sigla não cadastrada): 2"
      - listitem: "Unidade pertencente não encontrada: 1"
      - listitem: "Sala não encontrada: 5"
      - listitem: "Pessoa responsável não encontrada: 3"
      - listitem: "Pessoa responsável ambígua: 1"
    - button "Carregar relatório de pendências"
    - link "Importar cadastros de apoio (unidades, salas, pessoas)":
      - /url: /administracao/importacao/cadastros
  - textbox "Buscar itens da prévia":
    - /placeholder: Buscar por patrimônio ou descrição…
  - group "Filtrar por classificação":
    - button "Todos" [pressed]
    - button "Novo"
    - button "Existente"
    - button "Duplicado"
    - button "Inválido"
    - button "Conflitante"
  - table:
    - rowgroup:
      - row "Sel. Patrimônio Descrição Classificação":
        - columnheader "Sel."
        - columnheader "Patrimônio"
        - columnheader "Descrição"
        - columnheader "Classificação"
    - rowgroup:
      - row "Selecionar item 000123 000123 Cadeira giratória sintética de teste com braços reguláveis, encosto em tela, base cromada de cinco pés, rodízios de nylon e ajuste de altura a gás — descrição propositalmente longa para validar quebra de linha em telas de 320px sem rolagem horizontal da página Novo":
        - cell "Selecionar item 000123":
          - checkbox "Selecionar item 000123" [checked]
        - cell "000123"
        - cell "Cadeira giratória sintética de teste com braços reguláveis, encosto em tela, base cromada de cinco pés, rodízios de nylon e ajuste de altura a gás — descrição propositalmente longa para validar quebra de linha em telas de 320px sem rolagem horizontal da página"
        - cell "Novo"
      - row "Selecionar item 000124 000124 Mesa sintética <img src=x onerror=\"window.__xss=1\"> Novo":
        - cell "Selecionar item 000124":
          - checkbox "Selecionar item 000124" [checked]
        - cell "000124"
        - cell "Mesa sintética <img src=x onerror=\"window.__xss=1\">"
        - cell "Novo"
      - row "Selecionar item 000125 000125 Armário sintético <script>window.__xss=2</script> Existente":
        - cell "Selecionar item 000125":
          - checkbox "Selecionar item 000125" [checked]
        - cell "000125"
        - cell "Armário sintético <script>window.__xss=2</script>"
        - cell "Existente"
      - row "Registro duplicado na planilha de origem — não pode ser selecionado para importação. 000126 Cadeira sintética duplicada na planilha Duplicado":
        - cell "Registro duplicado na planilha de origem — não pode ser selecionado para importação.":
          - checkbox "Registro duplicado na planilha de origem — não pode ser selecionado para importação." [disabled]
        - cell "000126"
        - cell "Cadeira sintética duplicada na planilha"
        - cell "Duplicado"
      - 'row "Registro inválido: numero_patrimonial ausente; campo <img src=x onerror=\"window.__xss=1\"> inválido Registro sintético sem número patrimonial Inválido"':
        - 'cell "Registro inválido: numero_patrimonial ausente; campo <img src=x onerror=\"window.__xss=1\"> inválido"':
          - 'checkbox "Registro inválido: numero_patrimonial ausente; campo <img src=x onerror=\"window.__xss=1\"> inválido" [disabled]'
        - cell
        - cell "Registro sintético sem número patrimonial"
        - cell "Inválido"
      - row "Conflito com um registro existente — requer revisão manual antes de importar. 000128 Monitor sintético em conflito Conflitante":
        - cell "Conflito com um registro existente — requer revisão manual antes de importar.":
          - checkbox "Conflito com um registro existente — requer revisão manual antes de importar." [disabled]
        - cell "000128"
        - cell "Monitor sintético em conflito"
        - cell "Conflitante"
      - row "Selecionar item 0001290000000000000000000000000000 0001290000000000000000000000000000 Patrimônio sintético com número muito longo sem espaços Novo":
        - cell "Selecionar item 0001290000000000000000000000000000":
          - checkbox "Selecionar item 0001290000000000000000000000000000" [checked]
        - cell "0001290000000000000000000000000000"
        - cell "Patrimônio sintético com número muito longo sem espaços"
        - cell "Novo"
      - row "Selecionar item 000130 000130 Cadeira sintética existente Existente":
        - cell "Selecionar item 000130":
          - checkbox "Selecionar item 000130" [checked]
        - cell "000130"
        - cell "Cadeira sintética existente"
        - cell "Existente"
  - navigation "Paginação":
    - status: Exibindo 1–8 de 8 item(ns) · Página 1 de 1
    - text: Registros por página
    - combobox "Registros por página":
      - option "50" [selected]
      - option "100"
      - option "200"
    - button "Primeira" [disabled]
    - button "Anterior" [disabled]
    - button "Próxima" [disabled]
    - button "Última" [disabled]
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  1   | import AxeBuilder from "@axe-core/playwright";
  2   | import { expect, test, type Page, type Route } from "@playwright/test";
  3   | 
  4   | import { API_URL, installMocks, PREVIEW_ITEMS, seedSession, waitForHydration } from "./support/mocks";
  5   | import { VIEWPORTS, waitForAnimations } from "./support/screens";
  6   | 
  7   | // =============================================================================
  8   | // Telas de dados (importação Google Sheets, usuários, formulário de convite):
  9   | // estados reais de requisição, contadores com valores EXATOS do mock,
  10  | // transição de filtro sem perder resultados, seleção, modal (Esc/foco),
  11  | // sucesso só após a resposta do backend, erro de API, formulário com erros
  12  | // animados e loading, reduced motion, overflow em 9 resoluções, console limpo.
  13  | // Ver docs/ux/evidence/telas-dados.md.
  14  | // =============================================================================
  15  | 
  16  | const IMPORT_PATH = "/administracao/importacao/google-sheets";
  17  | const USERS_PATH = "/administracao/usuarios";
  18  | 
  19  | const count = (c: string) => PREVIEW_ITEMS.filter((i) => i.classification === c).length;
  20  | const EXPECTED_SUMMARY: Record<string, number> = {
  21  |   total: PREVIEW_ITEMS.length,
  22  |   novo: count("NOVO"),
  23  |   existente: count("EXISTENTE"),
  24  |   duplicado: count("DUPLICADO"),
  25  |   invalido: count("INVALIDO"),
  26  |   conflitante: count("CONFLITANTE"),
  27  | };
  28  | const ELIGIBLE = count("NOVO") + count("EXISTENTE");
  29  | 
  30  | /**
  31  |  * Segura uma requisição da API mockada até `release()`; então devolve ao mock
  32  |  * padrão (`fallback`) ou responde com `fulfill` customizado. Preflight OPTIONS
  33  |  * passa direto.
  34  |  */
  35  | async function holdRequest(
  36  |   page: Page,
  37  |   pathRegex: RegExp,
  38  |   method: string,
  39  |   respond?: (route: Route) => Promise<void>,
  40  | ): Promise<{ release: () => void; hit: Promise<void> }> {
  41  |   let release!: () => void;
  42  |   const gate = new Promise<void>((resolve) => (release = resolve));
  43  |   let markHit!: () => void;
  44  |   const hit = new Promise<void>((resolve) => (markHit = resolve));
  45  |   await page.route(
  46  |     (url) => url.href.startsWith(API_URL) && pathRegex.test(url.pathname),
  47  |     async (route) => {
  48  |       if (route.request().method() !== method) return route.fallback();
  49  |       markHit();
  50  |       await gate;
  51  |       if (respond) return respond(route);
  52  |       return route.fallback();
  53  |     },
  54  |   );
  55  |   return { release, hit };
  56  | }
  57  | 
  58  | function jsonError(route: Route, status: number): Promise<void> {
  59  |   const origin = route.request().headers()["origin"] ?? "*";
  60  |   return route.fulfill({
  61  |     status,
  62  |     headers: { "access-control-allow-origin": origin, "content-type": "application/json" },
  63  |     body: JSON.stringify({ error: { code: "INTERNAL", message: "detalhe interno que não deve aparecer" } }),
  64  |   });
  65  | }
  66  | 
  67  | async function openAs(page: Page, path: string): Promise<void> {
  68  |   await installMocks(page, { role: "ADM" });
  69  |   await seedSession(page, { role: "ADM" });
  70  |   await page.goto(path);
  71  |   await waitForHydration(page);
  72  | }
  73  | 
  74  | const status = (page: Page) => page.getByTestId("import-request-status");
  75  | const counterText = (page: Page, metric: string) =>
  76  |   page.locator(`[data-metric="${metric}"] .tabular-nums > span[aria-hidden="true"]`);
  77  | 
  78  | async function generatePreview(page: Page): Promise<void> {
  79  |   await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
> 80  |   await expect(page.getByText(`Página 1 de 1 — ${PREVIEW_ITEMS.length} item(ns)`)).toBeVisible();
      |                                                                                    ^ Error: expect(locator).toBeVisible() failed
  81  | }
  82  | 
  83  | test.use({ viewport: { width: 1366, height: 768 } });
  84  | 
  85  | test.describe("importação — estados e contadores", () => {
  86  |   test("idle → lendo (skeleton) → prévia pronta com contadores exatos e tabela", async ({ page }) => {
  87  |     await openAs(page, IMPORT_PATH);
  88  |     await expect(status(page)).toContainText("Aguardando pré-visualização");
  89  |     await expect(page.getByText("Nenhuma prévia gerada nesta sessão.")).toBeVisible();
  90  | 
  91  |     const preview = await holdRequest(page, /\/imports\/google-sheets\/preview$/, "POST");
  92  |     await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
  93  |     await preview.hit;
  94  |     await expect(status(page)).toContainText("Lendo planilha…");
  95  |     await expect(page.getByRole("status").filter({ hasText: "Lendo a planilha do Google Sheets…" })).toBeVisible();
  96  |     // Sem barra de progresso simulada.
  97  |     await expect(page.getByRole("progressbar")).toHaveCount(0);
  98  |     // Botão em loading (aria-busy), rótulo de estado real.
  99  |     await expect(page.getByRole("button", { name: "Gerando pré-visualização…" })).toHaveAttribute("aria-busy", "true");
  100 |     // Nada de prévia antes da resposta.
  101 |     await expect(page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" })).toHaveCount(0);
  102 | 
  103 |     preview.release();
  104 |     await expect(status(page)).toContainText("Prévia pronta");
  105 |     for (const [metric, value] of Object.entries(EXPECTED_SUMMARY)) {
  106 |       await expect(counterText(page, metric)).toHaveText(String(value));
  107 |     }
  108 |     await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(PREVIEW_ITEMS.length);
  109 |     // Alerta de revisão discreto (status, não alert) com ícone + texto.
  110 |     const review = page.getByRole("status").filter({ hasText: "exigem revisão" });
  111 |     await expect(review).toContainText(
  112 |       `${count("DUPLICADO") + count("INVALIDO") + count("CONFLITANTE")} registro(s)`,
  113 |     );
  114 |     // Badges com ícone + texto.
  115 |     const firstBadge = page.getByRole("table").locator("tbody tr").first().locator("td").last();
  116 |     await expect(firstBadge.locator("svg")).toHaveCount(1);
  117 |     await expect(firstBadge).toContainText("Novo");
  118 | 
  119 |     await waitForAnimations(page);
  120 |     const axe = await new AxeBuilder({ page })
  121 |       .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  122 |       .analyze();
  123 |     expect(axe.violations.map((v) => v.id)).toEqual([]);
  124 |   });
  125 | 
  126 |   test("filtro: resultados anteriores mantidos (aria-busy) até a resposta; depois só os filtrados", async ({ page }) => {
  127 |     await openAs(page, IMPORT_PATH);
  128 |     await generatePreview(page);
  129 |     const table = page.getByRole("table");
  130 |     const rows = table.locator("tbody tr");
  131 | 
  132 |     let release!: () => void;
  133 |     const gate = new Promise<void>((resolve) => (release = resolve));
  134 |     await page.route(
  135 |       (url) => url.href.startsWith(API_URL) && url.pathname.endsWith("/items") && url.search.includes("status=INVALIDO"),
  136 |       async (route) => {
  137 |         if (route.request().method() === "GET") await gate;
  138 |         await route.fallback();
  139 |       },
  140 |     );
  141 |     await page.getByRole("button", { name: "Inválido" }).click();
  142 |     await expect(table).toHaveAttribute("aria-busy", "true");
  143 |     await expect(rows).toHaveCount(PREVIEW_ITEMS.length);
  144 |     await expect(page.getByRole("status").filter({ hasText: "Atualizando…" })).toBeVisible();
  145 | 
  146 |     release();
  147 |     await expect(rows).toHaveCount(1);
  148 |     await expect(table).not.toHaveAttribute("aria-busy", "true");
  149 |     await expect(page.getByText("Página 1 de 1 — 1 item(ns)")).toBeVisible();
  150 |     await waitForAnimations(page);
  151 |     // Termina estável: opacidade 1 nas linhas.
  152 |     expect(await rows.first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  153 |   });
  154 | 
  155 |   test("busca sem resultados mostra estado vazio animado", async ({ page }) => {
  156 |     await openAs(page, IMPORT_PATH);
  157 |     await generatePreview(page);
  158 |     await page.getByLabel("Buscar itens da prévia").fill("inexistente-xyz");
  159 |     await expect(page.getByText("Nenhum item encontrado para os filtros atuais.")).toBeVisible();
  160 |     await expect(page.getByText("Ajuste a busca ou escolha outra classificação.")).toBeVisible();
  161 |   });
  162 | 
  163 |   test("seleção: checkbox + linha selecionada; modal com Esc e retorno de foco", async ({ page }) => {
  164 |     await openAs(page, IMPORT_PATH);
  165 |     await generatePreview(page);
  166 |     const checkbox = page.getByRole("checkbox", { name: "Selecionar item 000123" });
  167 |     const row = page.getByRole("row").filter({ has: checkbox });
  168 |     await expect(row).toHaveAttribute("data-state", "selected");
  169 |     await checkbox.uncheck();
  170 |     await expect(row).not.toHaveAttribute("data-state", "selected");
  171 |     await checkbox.check();
  172 |     await expect(row).toHaveAttribute("data-state", "selected");
  173 | 
  174 |     const trigger = page.getByRole("button", { name: "Confirmar Importação" });
  175 |     await trigger.click();
  176 |     const dialog = page.getByRole("dialog", { name: "Confirmar importação" });
  177 |     await expect(dialog).toBeVisible();
  178 |     expect(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBe(true);
  179 |     await page.keyboard.press("Escape");
  180 |     await expect(dialog).toBeHidden();
```