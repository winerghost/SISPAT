import { ApiError } from "@/lib/api-client";
import { rateLimitMessage } from "@/lib/api-errors";
import type { Density, FontScale } from "@/lib/ui-preferences";

// =============================================================================
// Textos da tela de Aparência (apresentação apenas). Mensagens de erro nunca
// reproduzem `message` do backend — só o código HTTP.
// =============================================================================

export const THEME_NOTICE = "Factory dark é o único tema oficial.";
export const THEME_NOTICE_DETAIL =
  "O design system não define tema claro nem “seguir o sistema”; aqui você ajusta só a densidade e o tamanho da fonte.";

export const DENSITY_OPTIONS: { value: Density; label: string; description: string }[] = [
  {
    value: "comfortable",
    label: "Confortável",
    description: "Espaçamento padrão do Factory, com mais respiro entre os elementos.",
  },
  {
    value: "compact",
    label: "Compacta",
    description: "Menos espaço entre cartões e linhas de tabela, para ver mais dados de uma vez.",
  },
];

export const FONT_SCALE_OPTIONS: { value: FontScale; label: string; description: string }[] = [
  { value: 100, label: "100%", description: "Tamanho padrão." },
  { value: 112, label: "112%", description: "Um pouco maior." },
  { value: 125, label: "125%", description: "Maior, para leitura mais confortável." },
];

export const CONFLICT_MESSAGE =
  "Suas preferências foram alteradas em outra sessão enquanto você editava. Carregamos a versão mais recente: revise e salve novamente.";

function commonErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 0) return "Falha de rede ao comunicar com a API. Verifique sua conexão e tente novamente.";
  if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
  if (error.status === 403) return "Você não tem permissão para alterar estas preferências.";
  if (error.status === 429) return rateLimitMessage(error);
  return null;
}

export function loadErrorMessage(error: unknown): string {
  return commonErrorMessage(error) ?? "Não foi possível carregar suas preferências de aparência. Tente novamente.";
}

export function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return "O servidor recusou os dados enviados. Revise as opções e tente novamente.";
  }
  return commonErrorMessage(error) ?? "Não foi possível salvar suas preferências agora. Tente novamente.";
}
