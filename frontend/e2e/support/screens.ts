import { expect, type Page } from "@playwright/test";

import { emptyDashboard } from "./dashboard-mocks";
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

export const CADASTROS_PATH = "/administracao/importacao/cadastros";

/** Abre a aba do cadastro (unidades já é a padrão) e gera a prévia dele. */
export async function generateCatalogPreview(page: Page, kind: "units" | "rooms" | "people"): Promise<void> {
  const tab = { units: "Unidades", rooms: "Salas", people: "Pessoas responsáveis" }[kind];
  const plural = { units: "unidades", rooms: "salas", people: "pessoas responsáveis" }[kind];
  await page.getByRole("tab", { name: tab }).click();
  await page.getByRole("button", { name: `Gerar prévia de ${plural}` }).click();
  await expect(page.getByRole("group", { name: "Resumo quantitativo da pré-visualização" })).toBeVisible();
  await expect(page.getByTestId("catalog-import-report")).toBeVisible();
  await expect(page.getByRole("table", { name: `Itens da prévia de ${plural}` })).toBeVisible();
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

/** Abre o painel lateral de detalhe do bem pelo número patrimonial (texto). */
function openAssetSheet(number: string) {
  return async (page: Page): Promise<void> => {
    await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
    await page.getByRole("button", { name: `Ver detalhes do patrimônio ${number}`, exact: true }).click();
    await expect(page.getByRole("dialog", { name: new RegExp(`Patrimônio ${number}`) })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Seções do bem" })).toBeVisible();
  };
}

/** Abre o painel lateral de detalhe da movimentação pelo bem (e estado) da linha. */
function openMovementSheet(number: string, status: string) {
  return async (page: Page): Promise<void> => {
    await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
    await page
      .getByRole("button", {
        name: new RegExp(`^Ver detalhes da movimentação do patrimônio ${number}, ${status}$`),
      })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: new RegExp(`Movimentação do patrimônio ${number}`) })).toBeVisible();
    await expect(page.getByRole("region", { name: "Origem e destino" })).toBeVisible();
  };
}

/** Abre o painel lateral de detalhe do inventário pelo nome (e estado) da linha. */
function openInventorySheet(name: string, status: string) {
  return async (page: Page): Promise<void> => {
    await expect(page.getByRole("table", { name: "Inventários" })).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(`^Ver detalhes do inventário ${name}.*, ${status}$`) })
      .first()
      .click();
    await expect(page.getByRole("dialog", { name: new RegExp(`Inventário ${name}`) })).toBeVisible();
    await expect(page.getByTestId("inventory-summary")).toBeVisible();
  };
}

/** Aguarda KPIs, os 3 gráficos (import dinâmico) e a tabela de detalhamento. */
export async function expectDashboardLoaded(page: Page): Promise<void> {
  await expect(page.locator("[data-dashboard-block=indicadores] [data-stat-card]")).toHaveCount(4, {
    timeout: 15_000,
  });
  for (const block of ["por-unidade", "por-situacao", "aquisicoes-mensais"]) {
    await expect(page.locator(`[data-dashboard-block=${block}] figure`)).toBeVisible({ timeout: 20_000 });
  }
  await expect(page.getByRole("table", { name: "Detalhamento de bens por unidade e tipo" })).toBeVisible();
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

/** Módulos sem backend: painel honesto, sem dados. Perfil escolhido por módulo. */
const MODULE_SCREENS: ScreenDef[] = (
  [
    ["relatorios", "/relatorios", "Relatórios", "RH"],
    ["vinculos-unidades", "/administracao/vinculos-unidades", "Vínculos de Unidades", "ADM"],
    ["auditoria", "/administracao/auditoria", "Auditoria", "ADM"],
    ["integracoes", "/administracao/integracoes", "Integrações", "ADM"],
    ["configuracoes-sistema", "/administracao/configuracoes-sistema", "Configurações do Sistema", "ADM"],
  ] as const
).map(([id, path, name, role]) => ({
  id: `modulo-${id}`,
  title: `${name} — módulo em preparação (${role})`,
  path,
  session: { role },
  prepare: async (page: Page) => {
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByTestId("module-state-panel")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Módulo em preparação" })).toBeVisible();
  },
}));

/** Módulo administrativo aberto por quem não é ADM: nega por padrão. */
const MODULE_DENIED_SCREEN: ScreenDef = {
  id: "modulo-admin-negado",
  title: "Auditoria — acesso restrito (USER)",
  path: "/administracao/auditoria",
  session: { role: "USER" },
  prepare: async (page) => {
    await expect(page.getByRole("heading", { level: 1, name: "Auditoria" })).toBeVisible();
    await expect(page.getByTestId("access-restricted")).toBeVisible();
    await expect(page.getByTestId("module-state-panel")).toBeHidden();
  },
};

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
    id: "ativar-conta-confirmar",
    title: "Ativar conta — confirmação do convite (token_hash)",
    path: "/ativar-conta?token_hash=hash-valido-e2e&type=invite",
    session: null,
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
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
    title: "Dashboard (/) — alertas com item crítico",
    path: "/",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "SISPAT-AGU" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Patrimônio duplicado" })).toBeVisible();
      await expect(page.locator("[data-alerts-widget] [data-severity=critical]")).toContainText("Crítico");
    },
  },
  {
    id: "dashboard-alertas-vazio",
    title: "Dashboard — alertas: Nenhum alerta",
    path: "/",
    session: { role: "USER", alerts: { generated_at: "2026-10-15T15:00:00Z", items: [], unavailable: [] } },
    prepare: async (page) => {
      await expect(page.getByText("Nenhum alerta", { exact: true })).toBeVisible();
    },
  },
  {
    id: "dashboard-alertas-erro",
    title: "Dashboard — alertas: erro com nova tentativa",
    path: "/",
    session: { role: "RH", alertsStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    id: "dashboard-alertas-parcial",
    title: "Dashboard — alertas: resultado parcial (unavailable)",
    path: "/",
    session: {
      role: "USER",
      alerts: {
        generated_at: "2026-10-15T15:00:00Z",
        items: [
          { code: "no_location", severity: "warning", title: "Bens sem localização", description: "Sem sala ou local.", count: 12 },
        ],
        unavailable: ["duplicate_asset_number", "sheets_conflicts"],
      },
    },
    prepare: async (page) => {
      await expect(page.getByText(/Resultado parcial/)).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Bens sem localização" })).toBeVisible();
    },
  },
  {
    id: "dashboard-ia",
    title: "Dashboard — Insights de IA e Pergunte ao SISPAT (resposta exibida)",
    path: "/",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 3, name: "Resumo executivo" })).toBeVisible();
      await expect(page.getByText("Gerado por IA — pode conter erros").first()).toBeVisible();
      await page.getByLabel("Sua pergunta").fill("Quantos bens estão sem responsável?");
      await page.getByRole("button", { name: "Enviar pergunta" }).click();
      await expect(page.locator("[data-ask-answer]")).toContainText("1234");
    },
  },
  {
    id: "dashboard-ia-indisponivel",
    title: "Dashboard — IA indisponível (estado neutro)",
    path: "/",
    session: { role: "RH", aiInsights: { status: "unavailable", generated_at: null, items: [] } },
    prepare: async (page) => {
      await expect(page.getByText("Insights de IA indisponíveis")).toBeVisible();
    },
  },
  {
    id: "dashboard-ia-erro-limite",
    title: "Dashboard — IA: erro nos insights e limite (429) na pergunta",
    path: "/",
    session: { role: "USER", aiInsightsStatus: 500, aiAskStatus: 429 },
    prepare: async (page) => {
      await expect(page.locator("[data-ai-unavailable]")).toBeVisible({ timeout: 15_000 });
      await page.getByLabel("Sua pergunta").fill("Pergunta sintética");
      await page.getByRole("button", { name: "Enviar pergunta" }).click();
      await expect(page.locator("[data-ask-rate-limited]")).toContainText("Limite atingido");
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
    id: "aparencia",
    title: "Configurações / Aparência (densidade e fonte)",
    path: "/configuracoes/aparencia",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Aparência" })).toBeVisible();
      await expect(page.getByText("Factory dark é o único tema oficial.")).toBeVisible();
      await expect(page.getByRole("radio", { name: "Confortável" })).toBeChecked();
      await expect(page.getByTestId("aparencia-previa")).toBeVisible();
    },
  },
  {
    id: "aparencia-compacta-125",
    title: "Aparência — compacta + fonte 125% (rascunho e salva)",
    path: "/configuracoes/aparencia",
    session: { role: "USER", prefs: { density: "compact", font_scale: 125, version: 3 } },
    prepare: async (page) => {
      await expect(page.getByRole("radio", { name: "Compacta" })).toBeChecked();
      await expect(page.getByRole("radio", { name: "125%" })).toBeChecked();
      await expect(page.locator("html")).toHaveAttribute("data-font-scale", "125");
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
    id: "perfis-permissoes",
    title: "Perfis e Permissões — aba Perfis (ADM)",
    path: "/administracao/perfis-permissoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Perfis e Permissões" })).toBeVisible();
      await expect(page.getByTestId("role-card-ADM")).toBeVisible();
      await expect(page.getByTestId("role-card-RH")).toBeVisible();
    },
  },
  {
    id: "perfis-permissoes-matriz",
    title: "Perfis e Permissões — aba Matriz (ADM)",
    path: "/administracao/perfis-permissoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await page.getByRole("tab", { name: "Matriz" }).click();
      await expect(page.getByRole("table", { name: "Matriz de permissões por perfil" })).toBeVisible();
    },
  },
  {
    id: "perfis-permissoes-erro",
    title: "Perfis e Permissões — erro com nova tentativa",
    path: "/administracao/perfis-permissoes",
    session: { role: "ADM", adminAccessStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    id: "perfis-permissoes-negado",
    title: "Perfis e Permissões — acesso restrito (USER)",
    path: "/administracao/perfis-permissoes",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByTestId("access-restricted")).toBeVisible();
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
    id: "salas",
    title: "Cadastro de salas (lista, filtros, situação)",
    path: "/administracao/salas",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
      await expect(page.getByText("Almoxarifado Sintético")).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 4 sala(s)")).toBeVisible();
    },
  },
  {
    id: "salas-nova",
    title: "Salas — diálogo de nova sala",
    path: "/administracao/salas",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
      await page.getByRole("button", { name: "Nova sala" }).click();
      const dialog = page.getByRole("dialog", { name: "Nova sala" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Unidade")).toBeVisible();
    },
  },
  {
    id: "salas-editar",
    title: "Salas — diálogo de edição (unidade somente leitura)",
    path: "/administracao/salas",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
      await page.getByRole("button", { name: "Editar Auditório Sintético" }).click();
      const dialog = page.getByRole("dialog", { name: "Editar sala" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Nome")).toHaveValue("Auditório Sintético");
    },
  },
  {
    id: "salas-inativar",
    title: "Salas — confirmação de inativação (registro preservado)",
    path: "/administracao/salas",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
      await page.getByRole("button", { name: "Inativar Auditório Sintético" }).click();
      const dialog = page.getByRole("dialog", { name: "Inativar sala" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("NÃO é excluída");
    },
  },
  {
    id: "responsaveis",
    title: "Cadastro de pessoas responsáveis (telefone mascarado)",
    path: "/administracao/responsaveis",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await expect(page.getByText("Responsável Sem Telefone")).toBeVisible();
      await expect(page.getByText("(••) •••••-4567")).toBeVisible();
    },
  },
  {
    id: "responsaveis-editar",
    title: "Responsáveis — diálogo de edição (telefone, só ADM)",
    path: "/administracao/responsaveis",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await page.getByRole("button", { name: "Editar Responsável Sem Telefone" }).click();
      const dialog = page.getByRole("dialog", { name: "Editar pessoa responsável" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Telefone")).toBeVisible();
    },
  },
  {
    id: "responsaveis-nova",
    title: "Responsáveis — diálogo de nova pessoa",
    path: "/administracao/responsaveis",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await page.getByRole("button", { name: "Nova pessoa" }).click();
      await expect(page.getByRole("dialog", { name: "Nova pessoa responsável" })).toBeVisible();
    },
  },
  {
    id: "responsaveis-inativar",
    title: "Responsáveis — confirmação de inativação",
    path: "/administracao/responsaveis",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await page.getByRole("button", { name: "Inativar Responsável Sem Telefone" }).click();
      await expect(page.getByRole("dialog", { name: "Inativar pessoa responsável" })).toBeVisible();
    },
  },
  {
    id: "unidades",
    title: "Cadastro de unidades (lista)",
    path: "/administracao/unidades",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await expect(page.getByText("4 unidade(s)")).toBeVisible();
    },
  },
  {
    id: "unidades-editar",
    title: "Unidades — diálogo de edição (sigla imutável, endereço só ADM)",
    path: "/administracao/unidades",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await page.getByRole("button", { name: /Gerenciar ESC-02/ }).click();
      const dialog = page.getByRole("dialog", { name: "Editar unidade" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Endereço")).toBeVisible();
    },
  },
  {
    id: "unidades-inativar",
    title: "Unidades — confirmação de inativação",
    path: "/administracao/unidades",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await page.getByRole("button", { name: /Gerenciar ESC-02/ }).click();
      await page.getByRole("button", { name: "Inativar unidade" }).click();
      await expect(page.getByRole("dialog", { name: "Inativar unidade" })).toBeVisible();
    },
  },
  {
    id: "unidades-reativar",
    title: "Unidades — confirmação de reativação de unidade inativa",
    path: "/administracao/unidades",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await page.getByRole("button", { name: /Reativar INAT-07/ }).click();
      await expect(page.getByRole("dialog", { name: "Reativar unidade" })).toBeVisible();
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
  {
    id: "importacao-pendencias",
    title: "Importação de bens — pendências de vínculo (relatório carregado)",
    path: "/administracao/importacao/google-sheets",
    session: { role: "ADM" },
    prepare: async (page) => {
      await generatePreview(page);
      await expect(page.getByTestId("pending-panel")).toBeVisible();
      await page.getByRole("button", { name: "Carregar relatório de pendências" }).click();
      await expect(page.getByText("Relatório carregado do servidor.")).toBeVisible();
      // O clique rola a página; volta ao topo para medir sem o cabeçalho fixo sobre o conteúdo.
      await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
    },
  },
  {
    id: "cadastros-vazio",
    title: "Importação de cadastros — estado inicial (abas)",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Cadastros de apoio" })).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Cadastro a importar" })).toBeVisible();
      await expect(page.getByText("Nenhuma prévia de unidades gerada nesta sessão.")).toBeVisible();
    },
  },
  {
    id: "cadastros-unidades",
    title: "Importação de cadastros — prévia de unidades (resumo, relatório, itens)",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "units");
    },
  },
  {
    id: "cadastros-salas",
    title: "Importação de cadastros — prévia de salas (prováveis duplicatas, XSS inerte)",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "rooms");
      await expect(page.getByText("Provável duplicata").first()).toBeVisible();
    },
  },
  {
    id: "cadastros-pessoas",
    title: "Importação de cadastros — prévia de pessoas (e-mail mascarado, telefone oculto)",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "people");
      await expect(page.getByText("E-mail: p***@exemplo.invalid").first()).toBeVisible();
      await expect(page.getByText("Página 1 de 2 · 30 item(ns)")).toBeVisible();
    },
  },
  {
    id: "cadastros-confirmar",
    title: "Importação de cadastros — diálogo de confirmação em massa",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "people");
      await page.getByRole("button", { name: "Confirmar importação" }).click();
      const dialog = page.getByRole("dialog", { name: "Confirmar importação de pessoas responsáveis" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Serão criados: 25 (Novo). Serão atualizados: 1 (Existente).");
    },
  },
  {
    id: "cadastros-unidades-sigla",
    title: "Importação de cadastros — unidades com opt-in de sigla de atalho marcado",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "units");
      await page.getByRole("button", { name: /Criar sigla nos itens selecionados desta página/ }).click();
      await expect(page.getByTestId("alias-optin-count")).toContainText("Siglas marcadas: 2");
      // O clique rola a página; volta ao topo para o cabeçalho fixo não cobrir alvos.
      await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
    },
  },
  {
    id: "cadastros-confirmar-sigla",
    title: "Importação de cadastros — diálogo de confirmação de unidades com siglas a criar",
    path: CADASTROS_PATH,
    session: { role: "ADM" },
    prepare: async (page) => {
      await generateCatalogPreview(page, "units");
      await page.getByRole("button", { name: /Criar sigla nos itens selecionados desta página/ }).click();
      await page.getByRole("button", { name: "Confirmar importação" }).click();
      const dialog = page.getByRole("dialog", { name: "Confirmar importação de unidades" });
      await expect(dialog).toContainText("Siglas de atalho a criar: 2");
    },
  },
  {
    id: "cadastros-resultado-falhas",
    title: "Importação de cadastros — resultado com falha por item",
    path: CADASTROS_PATH,
    session: { role: "ADM", catalogImport: { failures: true } },
    prepare: async (page) => {
      await generateCatalogPreview(page, "units");
      await page.getByRole("button", { name: "Confirmar importação" }).click();
      const dialog = page.getByRole("dialog", { name: "Confirmar importação de unidades" });
      await expect(dialog).toContainText("Serão criados: 2 (Novo). Serão atualizados: 1 (Existente).");
      await dialog.getByRole("button", { name: "Confirmar importação" }).click();
      await expect(page.getByTestId("catalog-import-result")).toBeVisible();
      await expect(page.getByTestId("catalog-import-failures")).toContainText("Falha sintética");
    },
  },
  {
    id: "cadastros-erro-planilha",
    title: "Importação de cadastros — erro 422 (planilha com estrutura inválida)",
    path: CADASTROS_PATH,
    session: { role: "ADM", catalogImport: { previewStatus: 422 } },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Gerar prévia de unidades" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "não tem a estrutura esperada" })).toBeVisible();
    },
  },

  // --- Menu sem 404: telas de consulta (todos os perfis, só leitura) -----------
  {
    id: "consulta-unidades",
    title: "Consulta de unidades (USER, escopo via /units/accessible)",
    path: "/unidades",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Unidades" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 4 unidade(s)")).toBeVisible();
    },
  },
  {
    id: "consulta-unidades-adm",
    title: "Consulta de unidades (ADM, atalho para o cadastro)",
    path: "/unidades",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Unidades" })).toBeVisible();
      await expect(page.getByRole("link", { name: /Gerenciar cadastro de unidades/ })).toBeVisible();
    },
  },
  {
    id: "consulta-unidades-erro",
    title: "Consulta de unidades — 403 com mensagem fixa",
    path: "/unidades",
    session: { role: "RH", accessibleUnitsStatus: 403 },
    prepare: async (page) => {
      await expect(page.getByRole("alert").filter({ hasText: "Você não tem permissão para consultar as unidades." })).toBeVisible();
    },
  },
  {
    id: "consulta-salas",
    title: "Consulta de salas (RH, só leitura)",
    path: "/salas-localizacoes",
    session: { role: "RH" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Salas e Localizações" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Salas" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 4 sala(s)")).toBeVisible();
    },
  },
  {
    id: "consulta-salas-erro",
    title: "Consulta de salas — 404 (fora do escopo) com mensagem fixa",
    path: "/salas-localizacoes",
    session: { role: "USER", lookupListStatus: 404 },
    prepare: async (page) => {
      await expect(page.getByRole("alert").filter({ hasText: "Nada foi encontrado no seu escopo de unidades." })).toBeVisible();
    },
  },
  {
    id: "consulta-responsaveis-user",
    title: "Consulta de responsáveis (USER: só nome, unidade e situação)",
    path: "/responsaveis",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Responsáveis" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await expect(page.getByText("Responsável Sem Telefone")).toBeVisible();
    },
  },
  {
    id: "consulta-responsaveis-adm",
    title: "Consulta de responsáveis (ADM: telefone mascarado e atalho)",
    path: "/responsaveis",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Pessoas responsáveis" })).toBeVisible();
      await expect(page.getByText("(••) •••••-4567")).toBeVisible();
      await expect(page.getByRole("link", { name: /Gerenciar cadastro de responsáveis/ })).toBeVisible();
    },
  },
  {
    id: "consulta-responsaveis-erro",
    title: "Consulta de responsáveis — erro 500 com nova tentativa",
    path: "/responsaveis",
    session: { role: "RH", lookupListStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  // --- Patrimônios (onda 2): lista real, detalhe, formulários, exclusão lógica ---
  {
    id: "patrimonios-adm",
    title: "Patrimônios — lista (ADM, filtros e ordenação)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Patrimônios" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 6 bem(ns)")).toBeVisible();
    },
  },
  {
    id: "patrimonios-user",
    title: "Patrimônios — lista (USER)",
    path: "/patrimonios",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 6 bem(ns)")).toBeVisible();
      await expect(page.getByRole("button", { name: "Novo bem" })).toBeVisible();
    },
  },
  {
    id: "patrimonios-rh",
    title: "Patrimônios — lista (RH, somente consulta)",
    path: "/patrimonios",
    session: { role: "RH" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Novo bem" })).toHaveCount(0);
    },
  },
  {
    id: "patrimonios-excluidos",
    title: "Patrimônios — ADM incluindo excluídos",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByRole("switch", { name: "Incluir excluídos" }).check();
      await expect(page.getByText("Página 1 de 1 · 7 bem(ns)")).toBeVisible();
      await expect(page.getByRole("cell", { name: "DEL-0001 Excluído" })).toBeVisible();
      // O check() rolou a página: volta ao topo para não medir controles sob o cabeçalho fixo.
      await page.evaluate(() => {
        document.scrollingElement?.scrollTo(0, 0);
        document.querySelector("main")?.scrollTo(0, 0);
      });
    },
  },
  {
    id: "patrimonios-vazio",
    title: "Patrimônios — filtro sem resultado",
    path: "/patrimonios",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByLabel("Buscar por número patrimonial ou descrição").fill("nada-corresponde");
      await expect(page.getByText("Nenhum bem encontrado para os filtros atuais.")).toBeVisible();
    },
  },
  {
    id: "patrimonios-erro",
    title: "Patrimônios — erro 500 com nova tentativa",
    path: "/patrimonios",
    session: { role: "RH", assetsListStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    id: "patrimonios-detalhe",
    title: "Patrimônios — detalhe do bem (ADM, ações)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: openAssetSheet("000123"),
  },
  {
    id: "patrimonios-detalhe-rh",
    title: "Patrimônios — detalhe do bem (RH, sem observações)",
    path: "/patrimonios",
    session: { role: "RH" },
    prepare: async (page) => {
      await openAssetSheet("000123")(page);
      await expect(page.getByRole("dialog", { name: /Patrimônio 000123/ }).getByText("Observações")).toHaveCount(0);
    },
  },
  {
    id: "patrimonios-historico",
    title: "Patrimônios — histórico do bem (ADM)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openAssetSheet("000123")(page);
      await page.getByRole("tab", { name: "Histórico" }).click();
      await expect(page.getByRole("list", { name: "Histórico do bem" })).toBeVisible();
    },
  },
  {
    id: "patrimonios-novo",
    title: "Patrimônios — novo bem (USER)",
    path: "/patrimonios",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByRole("button", { name: "Novo bem" }).click();
      const dialog = page.getByRole("dialog", { name: "Novo bem" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Localizado")).toHaveCount(0);
    },
  },
  {
    id: "patrimonios-novo-adm",
    title: "Patrimônios — novo bem (ADM: unidade proprietária e localizado)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByRole("button", { name: "Novo bem" }).click();
      const dialog = page.getByRole("dialog", { name: "Novo bem" });
      await expect(dialog.getByLabel("Localizado")).toBeVisible();
      await expect(dialog.getByLabel("Unidade proprietária")).toBeVisible();
    },
  },
  {
    id: "patrimonios-editar",
    title: "Patrimônios — editar bem (USER: número só leitura)",
    path: "/patrimonios",
    session: { role: "USER" },
    prepare: async (page) => {
      await openAssetSheet("000123")(page);
      await page.getByRole("button", { name: "Editar" }).click();
      const dialog = page.getByRole("dialog", { name: "Editar bem" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Número patrimonial")).toHaveCount(0);
    },
  },
  {
    id: "patrimonios-editar-adm",
    title: "Patrimônios — editar bem (ADM: número, localizado e proprietária)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openAssetSheet("000123")(page);
      await page.getByRole("button", { name: "Editar" }).click();
      const dialog = page.getByRole("dialog", { name: "Editar bem" });
      await expect(dialog.getByLabel("Número patrimonial")).toHaveValue("000123");
    },
  },
  {
    id: "patrimonios-excluir",
    title: "Patrimônios — confirmação de exclusão LÓGICA (ADM)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openAssetSheet("000123")(page);
      await page.getByRole("button", { name: "Excluir", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Excluir bem (exclusão lógica)" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("exclusão LÓGICA");
    },
  },
  {
    id: "patrimonios-restaurar",
    title: "Patrimônios — confirmação de restauração (ADM, bem excluído)",
    path: "/patrimonios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Patrimônios" })).toBeVisible();
      await page.getByRole("switch", { name: "Incluir excluídos" }).check();
      await page.getByRole("button", { name: "Ver detalhes do patrimônio DEL-0001" }).click();
      await page.getByRole("button", { name: "Restaurar", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Restaurar bem" })).toBeVisible();
    },
  },
  // --- Movimentações (onda 3): lista real, detalhe, solicitar, aprovar/rejeitar/cancelar ---
  {
    id: "movimentacoes-adm",
    title: "Movimentações — lista (ADM)",
    path: "/movimentacoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Movimentações" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 6 movimentação(ões)")).toBeVisible();
    },
  },
  {
    id: "movimentacoes-user",
    title: "Movimentações — lista (USER)",
    path: "/movimentacoes",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Solicitar movimentação" })).toBeVisible();
    },
  },
  {
    id: "movimentacoes-rh",
    title: "Movimentações — lista (RH, somente consulta)",
    path: "/movimentacoes",
    session: { role: "RH" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Solicitar movimentação" })).toHaveCount(0);
    },
  },
  {
    id: "movimentacoes-vazio",
    title: "Movimentações — filtro sem resultado",
    path: "/movimentacoes",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
      await page.getByLabel("Solicitada a partir de").fill("2026-12-01");
      await expect(page.getByText("Nenhuma movimentação encontrada para os filtros atuais.")).toBeVisible();
      // O fill() rolou a página: volta ao topo para não medir controles sob o cabeçalho fixo.
      await page.evaluate(() => {
        document.scrollingElement?.scrollTo(0, 0);
        document.querySelector("main")?.scrollTo(0, 0);
      });
    },
  },
  {
    id: "movimentacoes-erro",
    title: "Movimentações — erro 500 com nova tentativa",
    path: "/movimentacoes",
    session: { role: "RH", movementsListStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    id: "movimentacoes-detalhe-adm",
    title: "Movimentações — detalhe pendente (ADM, aprovar/rejeitar/cancelar)",
    path: "/movimentacoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openMovementSheet("000123", "Pendente")(page);
      const sheet = page.getByRole("dialog", { name: /Movimentação do patrimônio 000123/ });
      await expect(sheet.getByRole("button", { name: "Aprovar" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Rejeitar" })).toBeVisible();
    },
  },
  {
    id: "movimentacoes-detalhe-rh",
    title: "Movimentações — detalhe (RH, sem motivo nem autoria)",
    path: "/movimentacoes",
    session: { role: "RH" },
    prepare: async (page) => {
      await openMovementSheet("000123", "Pendente")(page);
      const sheet = page.getByRole("dialog", { name: /Movimentação do patrimônio 000123/ });
      await expect(sheet.getByText("Motivo da solicitação")).toHaveCount(0);
      await expect(sheet.getByText("Solicitante (identificador)")).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    },
  },
  {
    id: "movimentacoes-solicitar",
    title: "Movimentações — solicitar (USER, mesma unidade)",
    path: "/movimentacoes",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Movimentações" })).toBeVisible();
      await page.getByRole("button", { name: "Solicitar movimentação" }).click();
      const dialog = page.getByRole("dialog", { name: "Solicitar movimentação" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Bem — buscar por patrimônio ou descrição/).fill("00123");
      await dialog.getByLabel(/Bem — resultados/).selectOption({ index: 1 });
      await dialog.getByLabel(/Unidade de destino/).selectOption({ index: 1 });
      await expect(dialog.getByText("Mesma unidade do bem", { exact: false }).first()).toBeVisible();
    },
  },
  {
    id: "movimentacoes-aprovar",
    title: "Movimentações — confirmação de aprovação (ADM)",
    path: "/movimentacoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openMovementSheet("000123", "Pendente")(page);
      await page.getByRole("button", { name: "Aprovar", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Aprovar movimentação" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("ALTERA O BEM");
      await expect(dialog.getByText(/Situação atual do bem/)).toBeVisible();
    },
  },
  {
    id: "movimentacoes-rejeitar",
    title: "Movimentações — confirmação de rejeição com motivo (ADM)",
    path: "/movimentacoes",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openMovementSheet("000123", "Pendente")(page);
      await page.getByRole("button", { name: "Rejeitar", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Rejeitar movimentação" })).toBeVisible();
    },
  },
  // --- Inventários (onda 4): lista real, detalhe, criar, iniciar/encerrar/cancelar, conferir ---
  {
    id: "inventarios-adm",
    title: "Inventários — lista (ADM)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Inventários" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Inventários" })).toBeVisible();
      await expect(page.getByText("Página 1 de 1 · 5 inventário(s)")).toBeVisible();
      await expect(page.getByRole("button", { name: "Novo inventário" })).toBeVisible();
    },
  },
  {
    id: "inventarios-user",
    title: "Inventários — lista (USER, sem criar)",
    path: "/inventarios",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Inventários" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Novo inventário" })).toHaveCount(0);
    },
  },
  {
    id: "inventarios-rh",
    title: "Inventários — RH sem acesso (mensagem fixa)",
    path: "/inventarios",
    session: { role: "RH" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Inventários" })).toBeVisible();
      await expect(page.getByTestId("access-restricted")).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
    },
  },
  {
    id: "inventarios-vazio",
    title: "Inventários — filtro sem resultado",
    path: "/inventarios",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Inventários" })).toBeVisible();
      await page.getByLabel("Buscar inventário por nome").fill("nada-corresponde");
      await expect(page.getByText("Nenhum inventário encontrado para os filtros atuais.")).toBeVisible();
    },
  },
  {
    id: "inventarios-erro",
    title: "Inventários — erro 500 com nova tentativa",
    path: "/inventarios",
    session: { role: "USER", inventoriesListStatus: 500 },
    prepare: async (page) => {
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    id: "inventarios-detalhe-andamento",
    title: "Inventários — detalhe em andamento (ADM: resumo, itens e ações)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openInventorySheet("Inventário Anual PSU-TO", "Em andamento")(page);
      const sheet = page.getByRole("dialog", { name: /Inventário Inventário Anual PSU-TO/ });
      await expect(sheet.getByRole("button", { name: "Encerrar" })).toBeVisible();
      await expect(sheet.getByRole("list", { name: "Itens conferidos" })).toBeVisible();
    },
  },
  {
    id: "inventarios-detalhe-bens",
    title: "Inventários — bens da unidade (USER, pendentes com Conferir)",
    path: "/inventarios",
    session: { role: "USER" },
    prepare: async (page) => {
      await openInventorySheet("Inventário Anual PSU-TO", "Em andamento")(page);
      const sheet = page.getByRole("dialog", { name: /Inventário Inventário Anual PSU-TO/ });
      await sheet.getByRole("tab", { name: "Bens da unidade" }).click();
      await expect(sheet.getByRole("list", { name: "Bens da unidade" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Conferir o patrimônio 0000456" })).toBeVisible();
    },
  },
  {
    id: "inventarios-detalhe-encerrado",
    title: "Inventários — detalhe encerrado (imutável, sem ações)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openInventorySheet("Inventário NUC-03 concluído", "Concluído")(page);
      const sheet = page.getByRole("dialog", { name: /Inventário Inventário NUC-03 concluído/ });
      await expect(sheet.getByRole("group", { name: "Ações do inventário" })).toHaveCount(0);
    },
  },
  {
    id: "inventarios-novo",
    title: "Inventários — novo inventário (ADM)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("table", { name: "Inventários" })).toBeVisible();
      await page.getByRole("button", { name: "Novo inventário" }).click();
      await expect(page.getByRole("dialog", { name: "Novo inventário" })).toBeVisible();
    },
  },
  {
    id: "inventarios-iniciar",
    title: "Inventários — confirmação de início (ADM)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openInventorySheet("Inventário PSU-TO ainda aberto", "Aberto")(page);
      await page.getByRole("button", { name: "Iniciar", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Iniciar inventário" })).toBeVisible();
    },
  },
  {
    id: "inventarios-encerrar",
    title: "Inventários — confirmação de encerramento definitivo (ADM)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openInventorySheet("Inventário Anual PSU-TO", "Em andamento")(page);
      await page.getByRole("button", { name: "Encerrar", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Encerrar inventário" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("DEFINITIVO");
    },
  },
  {
    id: "inventarios-cancelar",
    title: "Inventários — confirmação de cancelamento (ADM)",
    path: "/inventarios",
    session: { role: "ADM" },
    prepare: async (page) => {
      await openInventorySheet("Inventário Anual PSU-TO", "Em andamento")(page);
      await page.getByRole("button", { name: "Cancelar inventário", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Cancelar inventário" })).toBeVisible();
    },
  },
  {
    id: "inventarios-conferir",
    title: "Inventários — conferir bem (USER)",
    path: "/inventarios",
    session: { role: "USER" },
    prepare: async (page) => {
      await openInventorySheet("Inventário Anual PSU-TO", "Em andamento")(page);
      const sheet = page.getByRole("dialog", { name: /Inventário Inventário Anual PSU-TO/ });
      await sheet.getByRole("tab", { name: "Bens da unidade" }).click();
      await sheet.getByRole("button", { name: "Conferir o patrimônio 0000456" }).click();
      const dialog = page.getByRole("dialog", { name: "Conferir bem" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Sim, foi encontrado").check();
      await expect(dialog.getByLabel("Local observado (opcional)")).toBeEnabled();
    },
  },
  // --- Dashboard de indicadores (/dashboard) e relatório imprimível -----------
  {
    id: "dashboard-painel",
    title: "Dashboard de indicadores — com dados (USER)",
    path: "/dashboard",
    session: { role: "USER" },
    prepare: async (page) => {
      await expectDashboardLoaded(page);
    },
  },
  {
    id: "dashboard-painel-vazio",
    title: "Dashboard de indicadores — sem bens (estados vazios honestos)",
    path: "/dashboard",
    session: { role: "RH", dashboard: emptyDashboard() },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(page.locator("[data-dashboard-empty]")).toHaveCount(4, { timeout: 15_000 });
      await expect(page.locator("[data-dashboard-block=indicadores] [data-stat-card]")).toHaveCount(4);
    },
  },
  {
    id: "dashboard-painel-erro",
    title: "Dashboard de indicadores — erro com nova tentativa",
    path: "/dashboard",
    session: {
      role: "USER",
      dashboardStatus: { resumo: 500, "por-unidade": 500, "por-situacao": 500, "aquisicoes-mensais": 500 },
    },
    prepare: async (page) => {
      await expect(page.locator("[data-dashboard-error]")).toHaveCount(5, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Tentar novamente" }).first()).toBeVisible();
    },
  },
  {
    id: "dashboard-relatorio",
    title: "Relatório patrimonial imprimível (ADM)",
    path: "/dashboard/relatorio",
    session: { role: "ADM" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Relatório patrimonial" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Imprimir / Salvar PDF" })).toBeVisible();
      await expectDashboardLoaded(page);
    },
  },
  // --- Menu sem 404: rotas pai e importações ----------------------------------
  {
    id: "importacoes-restrito",
    title: "Importações — acesso restrito (USER)",
    path: "/importacoes",
    session: { role: "USER" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Importações" })).toBeVisible();
      await expect(page.getByTestId("access-restricted")).toBeVisible();
    },
  },
  {
    id: "administracao-restrito",
    title: "Administração (pai) — acesso restrito (RH)",
    path: "/administracao",
    session: { role: "RH" },
    prepare: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
      await expect(page.getByTestId("access-restricted")).toBeVisible();
    },
  },
  // --- Menu sem 404: módulos ainda sem backend ("Módulo em preparação") --------
  ...MODULE_SCREENS,
  MODULE_DENIED_SCREEN,
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
