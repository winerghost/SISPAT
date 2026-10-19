// =============================================================================
// Módulos do menu que ainda NÃO têm backend. Fonte única do texto honesto do
// `ModuleStatePanel` (e do docs/ux/MENU_MODULOS.md). Nada aqui é dado do
// sistema: são descrições do que o módulo fará. Sem números, sem datas, sem
// promessas de prazo.
// =============================================================================

export type ModuleKey =
  | "relatorios"
  | "vinculos-unidades"
  | "auditoria"
  | "integracoes"
  | "configuracoes-sistema";

export interface ModuleDescriptor {
  key: ModuleKey;
  title: string;
  eyebrow: string;
  /** Uma frase sobre a finalidade do módulo. */
  summary: string;
  /** O que o módulo fará quando existir. */
  willDo: readonly string[];
  /** Próxima entrega, sem data inventada. */
  nextDelivery: string;
  /** Só ADM vê/usa (UX; o backend decide). */
  adminOnly: boolean;
  backHref: string;
  backLabel: string;
}

const WAITING_API =
  "Depende da API correspondente no backend, que ainda não foi publicada. Esta tela real substituirá este aviso quando ela existir.";

const ADMIN_BACK = { backHref: "/administracao/usuarios", backLabel: "Voltar para Usuários" } as const;
const HOME_BACK = { backHref: "/", backLabel: "Voltar ao início" } as const;

export const MODULES: Record<ModuleKey, ModuleDescriptor> = {
  relatorios: {
    key: "relatorios",
    title: "Relatórios",
    eyebrow: "Patrimônio",
    summary: "Relatórios e exportações do patrimônio.",
    willDo: [
      "Emitir relatórios por unidade, sala e responsável.",
      "Exportar em CSV e XLSX com proteção contra injeção de fórmulas.",
      "Aplicar o escopo de unidades e os campos permitidos ao seu perfil.",
    ],
    nextDelivery: WAITING_API,
    adminOnly: false,
    ...HOME_BACK,
  },
  "vinculos-unidades": {
    key: "vinculos-unidades",
    title: "Vínculos de Unidades",
    eyebrow: "Administração",
    summary: "Visão consolidada de quais usuários têm acesso a quais unidades.",
    willDo: [
      "Listar os vínculos entre usuários e unidades.",
      "Apoiar a revisão periódica de acessos por unidade.",
    ],
    nextDelivery:
      "Hoje os vínculos são gerenciados por usuário, em Usuários. Uma visão consolidada depende de API própria no backend.",
    adminOnly: true,
    ...ADMIN_BACK,
  },
  auditoria: {
    key: "auditoria",
    title: "Auditoria",
    eyebrow: "Administração",
    summary: "Consulta à trilha de auditoria do sistema.",
    willDo: [
      "Pesquisar eventos por período, usuário, operação e resultado.",
      "Mostrar acessos negados e alterações críticas, sem expor segredos.",
    ],
    nextDelivery:
      "Hoje o histórico de cada usuário está na aba Histórico, em Usuários. A consulta geral depende de API própria no backend.",
    adminOnly: true,
    ...ADMIN_BACK,
  },
  integracoes: {
    key: "integracoes",
    title: "Integrações",
    eyebrow: "Administração",
    summary: "Estado das integrações externas (Google Sheets e automações).",
    willDo: [
      "Mostrar se cada integração está configurada e disponível, sem exibir segredos.",
      "Apoiar o acompanhamento das sincronizações.",
    ],
    nextDelivery:
      "A importação do Google Sheets já funciona em Importação de Dados. O painel de integrações depende de API própria no backend.",
    adminOnly: true,
    ...ADMIN_BACK,
  },
  "configuracoes-sistema": {
    key: "configuracoes-sistema",
    title: "Configurações do Sistema",
    eyebrow: "Administração",
    summary: "Parâmetros gerais do sistema, para administradores.",
    willDo: [
      "Reunir parâmetros globais hoje espalhados por outras telas.",
      "Registrar na auditoria cada alteração de parâmetro.",
    ],
    nextDelivery:
      "A configuração da Inteligência Artificial já está disponível em Configurações. Os demais parâmetros dependem de API própria no backend.",
    adminOnly: true,
    ...ADMIN_BACK,
  },
};
