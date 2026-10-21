// =============================================================================
// Módulos do menu cuja tela real depende de API própria no backend. Fonte única
// do texto honesto do `ModuleStatePanel` (e do docs/ux/MENU_MODULOS.md). Nada
// aqui é dado do sistema: são descrições do que o módulo fará. Sem números, sem
// datas, sem promessas de prazo. Quando a tela real de um módulo é entregue, a
// página dele deixa de usar este catálogo e a entrada fica só como referência.
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
  "Esta tela depende de uma API própria no backend. Quando ela existir, a tela real substituirá este aviso.";

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
      "Os vínculos de cada usuário são gerenciados em Usuários. A visão consolidada por unidade é uma tela própria, entregue separadamente.",
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
      "O histórico de cada usuário está na aba Histórico, em Usuários. A consulta geral da trilha é uma tela própria, entregue separadamente.",
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
      "A importação do Google Sheets já funciona em Importação de Dados. O painel de integrações ainda não tem API no backend.",
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
      "A configuração da Inteligência Artificial já está disponível em Configurações. Os demais parâmetros ainda não têm API no backend.",
    adminOnly: true,
    ...ADMIN_BACK,
  },
};
