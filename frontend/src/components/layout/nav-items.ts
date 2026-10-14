import type { LucideIcon } from "lucide-react";
import {
  Home,
  Package,
  Building2,
  DoorOpen,
  Users,
  ClipboardList,
  ArrowLeftRight,
  BarChart3,
  Upload,
  ShieldCheck,
  Settings,
  UserCog,
  KeyRound,
  Link2,
  History,
  Plug,
  FileSpreadsheet,
  SlidersHorizontal,
  Lock,
  Sparkles,
} from "lucide-react";

// =============================================================================
// Itens de navegação do shell do SISPAT-AGU.
// =============================================================================
// Fonte única usada por sidebar.tsx e por header.tsx (breadcrumbs). Mantida
// separada do componente para ficar fácil de estender quando as rotas reais
// de cada módulo forem implementadas nas próximas rodadas.
//
// Visibilidade por perfil: itens com `adminOnly` só aparecem quando
// `GET /api/v1/me` informa o papel ADM (ver `filterNavItems`). Isso é SÓ UX:
// esconder um link não protege nada — o backend Flask continua autorizando
// cada requisição (RBAC + escopo por unidade, CLAUDE.md > Permissões) e as
// páginas administrativas tratam 403 por conta própria. Enquanto o perfil
// não é conhecido (carregando/erro), os itens restritos ficam ocultos
// (negar por padrão).
// =============================================================================

export interface NavLeaf {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Texto curto usado em páginas-índice (ex.: /configuracoes). */
  description?: string;
  /** Só exibido para o papel ADM (UX — a autorização real é do backend). */
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  href: string;
  icon: LucideIcon;
  children?: NavLeaf[];
  /** Só exibido para o papel ADM (UX — a autorização real é do backend). */
  adminOnly?: boolean;
}

/** Papel que libera a área administrativa na navegação. */
export const ADMIN_ROLE = "ADM";

/**
 * Filtra os itens visíveis para os papéis informados pelo backend (`/me`).
 * `roles` indefinido (perfil ainda desconhecido) = nega os itens restritos.
 */
export function filterNavItems(items: NavGroup[], roles: readonly string[] | undefined): NavGroup[] {
  const isAdmin = !!roles?.includes(ADMIN_ROLE);
  return items
    .filter((item) => !item.adminOnly || isAdmin)
    .map((item) =>
      item.children
        ? { ...item, children: item.children.filter((child) => !child.adminOnly || isAdmin) }
        : item,
    );
}

/** Rota-índice do grupo "Configurações". */
export const SETTINGS_HREF = "/configuracoes";

export const NAV_ITEMS: NavGroup[] = [
  { label: "Home", href: "/", icon: Home },
  { label: "Patrimônios", href: "/patrimonios", icon: Package },
  { label: "Unidades", href: "/unidades", icon: Building2 },
  { label: "Salas e Localizações", href: "/salas-localizacoes", icon: DoorOpen },
  { label: "Responsáveis", href: "/responsaveis", icon: Users },
  { label: "Inventários", href: "/inventarios", icon: ClipboardList },
  { label: "Movimentações", href: "/movimentacoes", icon: ArrowLeftRight },
  { label: "Relatórios", href: "/relatorios", icon: BarChart3 },
  { label: "Importações", href: "/importacoes", icon: Upload },
  {
    label: "Administração",
    href: "/administracao",
    icon: ShieldCheck,
    adminOnly: true,
    children: [
      { label: "Usuários", href: "/administracao/usuarios", icon: UserCog },
      { label: "Perfis e Permissões", href: "/administracao/perfis-permissoes", icon: KeyRound },
      { label: "Vínculos de Unidades", href: "/administracao/vinculos-unidades", icon: Link2 },
      { label: "Auditoria", href: "/administracao/auditoria", icon: History },
      { label: "Integrações", href: "/administracao/integracoes", icon: Plug },
      {
        label: "Importação de Dados → Google Sheets",
        href: "/administracao/importacao/google-sheets",
        icon: FileSpreadsheet,
      },
      {
        label: "Configurações do Sistema",
        href: "/administracao/configuracoes-sistema",
        icon: SlidersHorizontal,
      },
    ],
  },
  {
    // Grupo: o índice /configuracoes é alcançável pela trilha (breadcrumb).
    // "Aparência" entra na Etapa 3, junto com a página (sem link para 404).
    label: "Configurações",
    href: SETTINGS_HREF,
    icon: Settings,
    children: [
      {
        label: "Segurança",
        href: "/configuracoes/seguranca",
        icon: Lock,
        description: "Verificação em duas etapas (MFA) da sua conta.",
      },
      {
        label: "Inteligência Artificial",
        href: "/configuracoes/inteligencia-artificial",
        icon: Sparkles,
        adminOnly: true,
        description: "Provedor, modelo, funcionalidades e teto de uso da IA consultiva.",
      },
    ],
  },
];
