import type { InfoSlide } from "@/components/carousel";

// =============================================================================
// Orientações de uso exibidas no painel lateral do login.
// =============================================================================
// Texto NEUTRO de ajuda sobre o funcionamento do próprio sistema — não é
// comunicado oficial da AGU nem conteúdo institucional. Mantenha coerente com
// o comportamento real (convite ADM, MFA TOTP, sessão em sessionStorage).
// =============================================================================

export const LOGIN_GUIDANCE: InfoSlide[] = [
  {
    id: "mfa",
    eyebrow: "Segurança",
    title: "Verificação em duas etapas",
    body: "Perfis que exigem MFA pedem, após a senha, o código de 6 dígitos do seu aplicativo autenticador. Configure-o em Configurações › Segurança.",
  },
  {
    id: "convite",
    eyebrow: "Acesso",
    title: "Cadastro somente por convite",
    body: "Não há autocadastro. As contas são criadas por um administrador e ativadas pelo link de convite recebido por e-mail.",
  },
  {
    id: "codigos",
    eyebrow: "Segurança",
    title: "Nunca compartilhe códigos",
    body: "Senha e códigos de verificação são pessoais. Nenhum administrador ou suporte vai solicitá-los.",
  },
  {
    id: "sessao",
    eyebrow: "Sessão",
    title: "A sessão termina ao fechar a aba",
    body: "Por segurança, o acesso não fica salvo no navegador: ao fechar a aba, será preciso entrar novamente.",
  },
];

/** Imagem institucional opcional do painel do login. */
export interface AuthPanelImage {
  /** Asset AUTORIZADO (ex.: em /public, aprovado pela AGU). */
  src: string;
  alt: string;
}

/**
 * Slot de imagem institucional — VAZIO por padrão (nenhuma imagem incluída no
 * projeto). Só preencha com um asset formalmente autorizado.
 */
export const LOGIN_INSTITUTIONAL_IMAGE: AuthPanelImage | null = null;

/** Intervalo da rotação automática das orientações (ms). */
export const LOGIN_GUIDANCE_INTERVAL = 8000;
