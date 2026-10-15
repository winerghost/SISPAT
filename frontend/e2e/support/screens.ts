import { expect, type Page } from "@playwright/test";

import { installMocks, seedSession, waitForHydration, type MockOptions } from "./mocks";

// =============================================================================
// Catálogo de telas/estados verificados pelas suítes responsive e a11y.
// =============================================================================

export interface ScreenDef {
  id: string;
  title: string;
  path: string;
  /** null = sem sessão (rotas públicas). */
  session: MockOptions | null;
  /** Leva a tela ao estado a ser verificado (abre modal, gera prévia...). */
  prepare?: (page: Page) => Promise<void>;
}

export const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** Breakpoint `lg` do Tailwind: abaixo dele a sidebar vira menu móvel. */
export const LG = 1024;

async function generatePreview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pré-visualizar Importação" }).click();
  await expect(page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("Página 1 de 1")).toBeVisible();
}

/** Abre o painel lateral de detalhe do usuário e, se pedido, uma aba. */
async function openUserSheet(page: Page, name: string, tab?: string): Promise<void> {
  await expect(page.getByRole("table", { name: "Usuários" })).toBeVisible();
  await page.getByRole("button", { name: `Gerenciar ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tablist", { name: "Seções do usuário" })).toBeVisible();
  if (tab) {
    await sheet.getByRole("tab", { name: tab }).click();
    await expect(sheet.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }
}

export const RH_NAME = "Pessoa Sintética RH";
export const ADMIN_NAME = "Pessoa Sintética Administradora com Nome Bastante Longo para Teste";

async function openMobileMenuIfPresent(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Abrir menu de navegação" });
  if (await trigger.isVisible()) {
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "SISPAT-AGU" })).toBeVisible();
  }
}

export const SCREENS: ScreenDef[] = [
  {
    id: "login",
    title: "Login",
    path: "/login",
    session: null,
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
    },
  },
  {
    id: "login-mfa",
    title: "Login — desafio MFA",
    path: "/login",
    session: null,
    prepare: async (page) => {
      await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
      await page.getByLabel("Senha").fill("senha-sintetica-123");
      await page.getByRole("button", { name: "Entrar" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Verificação em duas etapas" })).toBeVisible();
    },
  },
  {
    id: "login-enroll",
    title: "Login — cadastro do primeiro fator TOTP (ADM sem fator)",
    path: "/login",
    session: null,
    prepare: async (page) => {
      await page.getByLabel("E-mail").fill("adm.sintetico@exemplo.invalid");
      await page.getByLabel("Senha").fill("senha-sintetica-123");
      await page.getByRole("button", { name: "Entrar" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Ativar verificação em duas etapas" }),
      ).toBeVisible();
      await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
    },
  },
  {
    id: "ativar-conta",
    title: "Ativar conta (convite/recuperação)",
    path: "/ativar-conta",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Ativar conta" })).toBeVisible();
    },
  },
  {
    id: "ativar-conta-invalido",
    title: "Ativar conta — link inválido",
    path: "/ativar-conta",
    session: null,
    prepare: async (page) => {
      await expect(page.getByText("Este link de convite é inválido")).toBeVisible();
    },
  },
  {
    id: "dashboard",
    title: "Dashboard (/)",
    path: "/",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
    },
  },
  {
    id: "menu",
    title: "Sidebar/Header — menu (móvel abaixo de 1024px)",
    path: "/",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
      await openMobileMenuIfPresent(page);
    },
  },
  {
    id: "seguranca",
    title: "Configurações / Segurança (MFA)",
    path: "/configuracoes/seguranca",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Remover" })).toBeVisible();
    },
  },
  {
    id: "seguranca-ativar",
    title: "Segurança — ativação TOTP (QR code)",
    path: "/configuracoes/seguranca",
    session: { role: "USER", hasVerifiedFactor: false },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Ativar MFA" }).click();
      await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
    },
  },
  {
    id: "seguranca-modal",
    title: "Segurança — modal remover fator",
    path: "/configuracoes/seguranca",
    session: { role: "ADM" },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Remover" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    id: "configuracoes",
    title: "Configurações — índice",
    path: "/configuracoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
      await expect(page.getByRole("main").getByRole("link", { name: /Inteligência Artificial/ })).toBeVisible();
    },
  },
  {
    id: "ia",
    title: "Configurações / Inteligência Artificial (ADM)",
    path: "/configuracoes/inteligencia-artificial",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("switch", { name: "Ligar a Inteligência Artificial" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Testar conexão" })).toBeVisible();
    },
  },
  {
    id: "ia-deepseek",
    title: "IA — aviso de transferência internacional (DeepSeek)",
    path: "/configuracoes/inteligencia-artificial",
    session: { role: "ADM" },
    prepare: async (page) => {
      await page.getByLabel("Provedor", { exact: true }).selectOption("deepseek");
      await expect(page.getByRole("dialog", { name: "Transferência internacional de dados" })).toBeVisible();
    },
  },
  {
    id: "usuarios",
    title: "Administração de usuários",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByText("rh.sintetico@exemplo.invalid")).toBeVisible();
    },
  },
  {
    id: "usuarios-convite",
    title: "Usuários — modal de convite",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table")).toBeVisible();
      await page.getByRole("button", { name: "Convidar Usuário" }).click();
      const dialog = page.getByRole("dialog", { name: "Convidar Usuário" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("checkbox", { name: /PSU-TO/ })).toBeVisible();
    },
  },
  {
    id: "usuarios-filtros",
    title: "Usuários — busca e filtros aplicados (inativos)",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table")).toBeVisible();
      await page.getByRole("group", { name: "Filtrar por situação" }).getByRole("button", { name: "Inativos" }).click();
      await expect(page.getByText("Página 1 de 1 · 1 usuário(s)")).toBeVisible();
      await expect(page.getByRole("button", { name: "Limpar filtros" })).toBeVisible();
    },
  },
  {
    id: "usuarios-detalhe-perfil",
    title: "Usuários — detalhe: perfil e unidades",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, RH_NAME);
      const sheet = page.getByRole("dialog", { name: RH_NAME });
      await expect(sheet.getByRole("radio", { name: /RH — Recursos Humanos/ })).toBeChecked();
      await expect(sheet.getByText("FORA-09 — Unidade Sintética Fora do Escopo")).toBeVisible();
    },
  },
  {
    id: "usuarios-detalhe-conta",
    title: "Usuários — detalhe: conta (ações)",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, RH_NAME, "Conta");
      await expect(page.getByRole("button", { name: "Reativar conta" })).toBeVisible();
    },
  },
  {
    id: "usuarios-detalhe-foto",
    title: "Usuários — detalhe: foto (URL assinada)",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, ADMIN_NAME, "Foto");
      await expect(page.getByRole("button", { name: "Remover foto" })).toBeVisible();
    },
  },
  {
    id: "usuarios-detalhe-historico",
    title: "Usuários — detalhe: histórico paginado",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, ADMIN_NAME, "Histórico");
      await expect(page.getByText("Página 1 de 2 · 12 evento(s)")).toBeVisible();
    },
  },
  {
    id: "usuarios-confirmar-adm",
    title: "Usuários — confirmação de promoção a ADM",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, RH_NAME);
      await page.getByRole("radio", { name: /ADM — Administração/ }).check();
      await page.getByRole("button", { name: "Salvar perfil e unidades" }).click();
      await expect(page.getByRole("dialog", { name: "Promover a administrador" })).toBeVisible();
    },
  },
  {
    id: "usuarios-confirmar-desativar",
    title: "Usuários — confirmação de desativação (motivo)",
    path: "/administracao/usuarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openUserSheet(page, ADMIN_NAME, "Conta");
      await page.getByRole("button", { name: "Desativar conta" }).click();
      await expect(page.getByRole("dialog", { name: "Desativar conta" })).toBeVisible();
    },
  },
  {
    id: "perfil",
    title: "Configurações / Meu perfil (foto)",
    path: "/configuracoes/perfil",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Meu perfil" })).toBeVisible();
      await expect(page.getByText("Sem foto — as iniciais são exibidas no lugar.")).toBeVisible();
    },
  },
  {
    id: "importacao",
    title: "Importação Google Sheets (cards, filtros, tabela)",
    path: "/administracao/importacao/google-sheets",
    session: { role: "ADM" },
    prepare: generatePreview,
  },
  {
    id: "importacao-confirmar",
    title: "Importação — modal de confirmação",
    path: "/administracao/importacao/google-sheets",
    session: { role: "ADM" },
    prepare: async (page) => {
      await generatePreview(page);
      const confirm = page.getByRole("button", { name: "Confirmar Importação" });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(page.getByRole("dialog", { name: "Confirmar importação" })).toBeVisible();
    },
  },
];

/** Prepara mocks + sessão, navega e leva a tela ao estado desejado. */
export async function openScreen(page: Page, screen: ScreenDef): Promise<void> {
  // ADM entra pelo login com aal1 para exercitar o desafio MFA.
  const loginAsAdmMfa = screen.id === "login-mfa";
  const loginAsAdmEnroll = screen.id === "login-enroll";
  await installMocks(
    page,
    loginAsAdmEnroll
      ? { role: "ADM", aal: "aal1", hasVerifiedFactor: false }
      : loginAsAdmMfa
        ? { role: "ADM", aal: "aal1" }
        : (screen.session ?? {}),
  );
  if (screen.session) await seedSession(page, screen.session);
  await page.goto(screen.path);
  await waitForHydration(page);
  if (screen.prepare) await screen.prepare(page);
  await waitForAnimations(page);
}

/**
 * Aguarda as animações FINITAS (entrada de página/modal, 150–200ms) terminarem
 * antes de medir (axe calcula contraste com a opacidade corrente — medir no
 * meio de um fade gera falso positivo). Animações infinitas (shimmer do
 * Skeleton, spinner) são ignoradas.
 */
export async function waitForAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => {
      const iterations = a.effect?.getComputedTiming().iterations;
      return iterations === Infinity || a.playState !== "running";
    }),
  );
}
