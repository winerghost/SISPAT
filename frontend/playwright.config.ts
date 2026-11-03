import { defineConfig, devices } from "@playwright/test";

// =============================================================================
// SISPAT-AGU — playwright.config.ts (QA de responsividade, a11y e e2e)
// =============================================================================
// O Next sobe com variáveis SINTÉTICAS: nenhuma chamada sai para o Supabase
// real (tocbtonqnahmtegfkrmn), para a API Flask real ou para a VPS. Toda
// requisição para fora de localhost:PORT é abortada em `e2e/support/mocks.ts`
// e as rotas do Supabase Auth/Flask são respondidas por mocks (`page.route`).
//
// Projetos:
//   - responsive: matriz tela × viewport (320 → 1920) — e2e/responsive.spec.ts
//   - a11y:       axe-core (WCAG 2.0/2.1/2.2 A+AA) + testes de teclado/foco
//   - e2e:        fluxos funcionais (proteção de rota, login/logout, filtros,
//                 convite) e não-execução de marcadores XSS.
// Evidências (screenshots, traces) ficam em test-results/ (não versionado).
// =============================================================================

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export const SYNTHETIC_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  // Valor fictício (não é JWT válido de nenhum projeto) — só para o SDK inicializar.
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key-ficticia",
  NEXT_PUBLIC_API_URL: "http://127.0.0.1:5000/api",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "pt-BR",
    timezoneId: "America/Araguaina",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    // Unitário puro (sem navegador): helper `cn` e tokens do DESIGN.md.
    { name: "unit", testMatch: /(cn|pagination)\.spec\.ts/ },
    { name: "responsive", testMatch: /responsive\.spec\.ts/ },
    { name: "a11y", testMatch: /a11y\.spec\.ts/ },
    { name: "e2e", testMatch: /functional\.spec\.ts/ },
    // Dashboard de indicadores e relatório imprimível (/dashboard*).
    { name: "dashboard", testMatch: /(^|[\/])dashboard\.spec\.ts$/ },
    // Rolagem única da página (janela nunca rola; só o <main>) + axe.
    { name: "scroll", testMatch: /page-scroll\.spec\.ts/ },
    // Fundação de animações (reduced motion, transição de rota, modal, hidratação).
    { name: "motion", testMatch: /motion-.*\.spec\.ts/ },
  ],
  webServer: {
    // Bundle de PRODUÇÃO, não `next dev`: com `next dev` cada rota compila sob
    // demanda na primeira visita, e com vários workers disputando o mesmo
    // servidor a compilação inicial estourava o timeout do teste (falhas de
    // orçamento, não de UI, em responsive/a11y/dashboard-charts). `next build`
    // também faz os NEXT_PUBLIC_* sintéticos serem embutidos como em produção,
    // que é o que a imagem Docker serve.
    command: `npx next build && npx next start --port ${PORT}`,
    url: `${BASE_URL}/login`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { ...SYNTHETIC_ENV },
    stdout: "ignore",
    stderr: "pipe",
  },
});
