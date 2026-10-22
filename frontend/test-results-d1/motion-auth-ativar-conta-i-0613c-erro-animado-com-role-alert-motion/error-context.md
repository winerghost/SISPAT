# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: motion-auth.spec.ts >> ativar conta: indicador de etapas e erro animado com role=alert
- Location: e2e\motion-auth.spec.ts:190:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('list', { name: 'Etapas da ativação' })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('list', { name: 'Etapas da ativação' }) with timeout 15000ms
  - waiting for getByRole('list', { name: 'Etapas da ativação' })

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
  97  |   await expect(page.getByLabel("Senha")).toHaveAccessibleDescription("E-mail ou senha incorretos.");
  98  | 
  99  |   const rec = (await inserted(page)).find((r) => r.role === "alert");
  100 |   expect(rec, "alerta registrado na inserção").toBeTruthy();
  101 |   expect(rec!.opacity, "erro entra com fade (opacidade inicial < 1)").toBeLessThan(1);
  102 | 
  103 |   await waitForAnimations(page);
  104 |   const final = await alert.evaluate((el) => getComputedStyle(el.parentElement!).opacity);
  105 |   expect(final).toBe("1");
  106 |   expect(await axeViolations(page)).toEqual([]);
  107 |   expect(errors).toEqual([]);
  108 | });
  109 | 
  110 | test("submit: botão em loading (aria-busy, desabilitado) enquanto o Supabase responde", async ({ page }) => {
  111 |   await gotoLogin(page);
  112 |   // Atrasa só o token (registrado depois de installMocks → tem precedência).
  113 |   await page.route(`${SUPABASE_URL}/auth/v1/token**`, async (route) => {
  114 |     await new Promise((r) => setTimeout(r, 1200));
  115 |     await route.fallback();
  116 |   });
  117 |   await page.getByLabel("E-mail").fill("invalido@exemplo.invalid");
  118 |   await page.getByLabel("Senha").fill("x");
  119 |   await page.getByRole("button", { name: "Entrar" }).click();
  120 | 
  121 |   const busy = page.getByRole("button", { name: "Entrando…" });
  122 |   await expect(busy).toHaveAttribute("aria-busy", "true");
  123 |   await expect(busy).toBeDisabled();
  124 |   await expect(busy.locator("svg.animate-spin-slow")).toHaveCount(1);
  125 |   await expect(page.locator("#login-error[role=alert]")).toHaveText("E-mail ou senha incorretos.");
  126 |   await expect(page.getByRole("button", { name: "Entrar" })).toBeEnabled();
  127 |   await expect(page.getByRole("button", { name: "Entrar" })).not.toHaveAttribute("aria-busy", "true");
  128 | });
  129 | 
  130 | test("senha → MFA: troca com fade, foco no código, Voltar devolve foco e sucesso confirma", async ({ page }) => {
  131 |   const errors = trackConsoleErrors(page);
  132 |   await gotoLogin(page, { role: "ADM", aal: "aal1" });
  133 |   await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
  134 |   await page.getByLabel("Senha").fill("senha-sintetica-123");
  135 |   await page.getByRole("button", { name: "Entrar" }).click();
  136 | 
  137 |   await expect(page.getByRole("heading", { level: 1, name: "Verificação em duas etapas" })).toBeVisible();
  138 |   const codigo = page.getByLabel("Código de verificação");
  139 |   await expect(codigo).toBeFocused();
  140 |   await waitForAnimations(page);
  141 |   expect(await axeViolations(page)).toEqual([]);
  142 | 
  143 |   // Voltar: descarta a etapa e devolve o foco ao e-mail (não cai no <body>).
  144 |   await page.getByRole("button", { name: "Voltar" }).click();
  145 |   await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
  146 |   await expect(page.getByLabel("E-mail")).toBeFocused();
  147 | 
  148 |   // De novo até o MFA; código errado → alerta; certo → status + redirect.
  149 |   await page.getByLabel("Senha").fill("senha-sintetica-123");
  150 |   await page.getByRole("button", { name: "Entrar" }).click();
  151 |   await expect(codigo).toBeFocused();
  152 |   await codigo.fill("000000");
  153 |   await page.getByRole("button", { name: "Verificar" }).click();
  154 |   await expect(page.locator("#login-error[role=alert]")).toHaveText("Código inválido ou expirado. Tente novamente.");
  155 |   await expect(codigo).toHaveAttribute("aria-describedby", "login-error");
  156 | 
  157 |   await recordInsertions(page);
  158 |   await codigo.fill("123456");
  159 |   await page.getByRole("button", { name: "Verificar" }).click();
  160 |   // `next dev` compila "/" sob demanda: sob carga a navegação pode passar de 15s.
  161 |   await expect(page).toHaveURL(/\/$/, { timeout: 45_000 });
  162 |   await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
  163 |   const statuses = (await inserted(page)).filter((r) => r.role === "status").map((r) => r.text);
  164 |   expect(statuses).toContain("Acesso confirmado. Redirecionando…");
  165 |   expect(errors).toEqual([]);
  166 | });
  167 | 
  168 | test.describe("prefers-reduced-motion", () => {
  169 |   test.use({ reducedMotion: "reduce" });
  170 | 
  171 |   test("erro aparece sem deslocamento e a etapa MFA mantém o foco", async ({ page }) => {
  172 |     await gotoLogin(page, { role: "ADM", aal: "aal1" });
  173 |     await recordInsertions(page);
  174 |     await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
  175 |     await page.getByLabel("Senha").fill("senha-sintetica-123");
  176 |     await page.getByRole("button", { name: "Entrar" }).click();
  177 |     const codigo = page.getByLabel("Código de verificação");
  178 |     await expect(codigo).toBeFocused();
  179 |     await codigo.fill("000000");
  180 |     await page.getByRole("button", { name: "Verificar" }).click();
  181 |     const alert = page.locator("#login-error[role=alert]");
  182 |     await expect(alert).toHaveText("Código inválido ou expirado. Tente novamente.");
  183 |     const rec = (await inserted(page)).find((r) => r.role === "alert");
  184 |     expect(rec, "alerta registrado").toBeTruthy();
  185 |     expect(rec!.transform, "sem deslocamento sob reduced motion").toBe("none");
  186 |     expect(rec!.opacity).toBe(1);
  187 |   });
  188 | });
  189 | 
  190 | test("ativar conta: indicador de etapas e erro animado com role=alert", async ({ page }) => {
  191 |   const errors = trackConsoleErrors(page);
  192 |   await installMocks(page, { role: "USER" });
  193 |   await seedSession(page, { role: "USER" });
  194 |   await page.goto("/ativar-conta");
  195 |   await waitForHydration(page);
  196 |   const steps = page.getByRole("list", { name: "Etapas da ativação" });
> 197 |   await expect(steps).toBeVisible();
      |                       ^ Error: expect(locator).toBeVisible() failed
  198 |   await expect(steps.locator("[aria-current='step']")).toContainText("Definir senha");
  199 |   await page.getByLabel("Nova senha").fill("12345678");
  200 |   await page.getByLabel("Confirmar senha").fill("87654321");
  201 |   await page.getByRole("button", { name: "Ativar conta" }).click();
  202 |   await expect(page.locator("#ativar-erro[role=alert]")).toHaveText("As senhas não coincidem.");
  203 |   await expect(page.getByLabel("Confirmar senha")).toHaveAccessibleDescription("As senhas não coincidem.");
  204 |   expect(await axeViolations(page)).toEqual([]);
  205 |   expect(errors).toEqual([]);
  206 | });
  207 | 
  208 | test("segurança: etapas QR → código → concluído só após a verificação real", async ({ page }) => {
  209 |   const errors = trackConsoleErrors(page);
  210 |   await installMocks(page, { role: "USER", hasVerifiedFactor: false });
  211 |   await seedSession(page, { role: "USER", hasVerifiedFactor: false });
  212 |   await page.goto("/configuracoes/seguranca");
  213 |   await waitForHydration(page);
  214 |   await page.getByRole("button", { name: "Ativar MFA" }).click();
  215 |   await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  216 | 
  217 |   const steps = page.getByRole("list", { name: "Etapas da ativação do MFA" });
  218 |   await expect(steps.locator("[aria-current='step']")).toContainText("Escanear QR code");
  219 |   const input = page.getByLabel("Código do aplicativo");
  220 |   await input.fill("000000");
  221 |   await expect(steps.locator("[aria-current='step']")).toContainText("Informar código");
  222 | 
  223 |   // Código errado: alerta, sem "concluído".
  224 |   await page.getByRole("button", { name: "Confirmar" }).click();
  225 |   await expect(page.locator("#mfa-erro[role=alert]")).toHaveText("Código inválido ou expirado. Tente novamente.");
  226 |   await expect(page.getByText("Verificação em duas etapas ativada.")).toHaveCount(0);
  227 | 
  228 |   await input.fill("123456");
  229 |   await page.getByRole("button", { name: "Confirmar" }).click();
  230 |   await expect(page.getByRole("status").filter({ hasText: "Verificação em duas etapas ativada." })).toBeVisible();
  231 |   await expect(steps.locator("[aria-current='step']")).toHaveCount(0);
  232 |   await expect(steps.getByText("(concluída)")).toHaveCount(3);
  233 |   // (O mock não promove o fator a "verified" em GET /user, então a lista não muda aqui.)
  234 |   expect(await axeViolations(page)).toEqual([]);
  235 |   expect(errors).toEqual([]);
  236 | });
  237 | 
```