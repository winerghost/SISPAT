import { ApiError } from "@/lib/api-client";
import type {
  AiFeatureKey,
  AiProvider,
  AiStatus,
  AiTestResponse,
} from "@/lib/ai-settings-api";
import type { StatusIndicatorState } from "@/components/ui/status-indicator";

// =============================================================================
// Textos da tela de IA (apresentação apenas). Mensagens de erro nunca
// reproduzem `message` do backend/provedor — só o código HTTP/`error.code`.
// =============================================================================

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  none: "Nenhum",
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
};

export const FEATURE_TEXT: Record<AiFeatureKey, { label: string; description: string }> = {
  alerts_explain: {
    label: "Alertas explicados",
    description: "Prioriza e explica em linguagem simples os alertas que o sistema já detectou.",
  },
  executive_summary: {
    label: "Resumo executivo",
    description: "Resumo periódico por unidade, gerado só a partir de números agregados.",
  },
  assistant: {
    label: "Pergunte ao SISPAT",
    description: "Responde perguntas com consultas somente de leitura, no escopo de cada usuário.",
  },
  data_quality: {
    label: "Sugestões de qualidade de dados",
    description: "Sugere correções para revisão humana; nada é aplicado automaticamente.",
  },
};

export const STATUS_TEXT: Record<AiStatus, { state: StatusIndicatorState; label: string; detail: string }> = {
  active: {
    state: "success",
    label: "Ativa",
    detail: "A IA está ligada e pronta para responder.",
  },
  disabled: {
    state: "idle",
    label: "Desligada",
    detail: "Nenhuma funcionalidade de IA é executada. O sistema funciona normalmente sem ela.",
  },
  unavailable: {
    state: "warning",
    label: "Indisponível",
    detail:
      "A IA está ligada, mas não pode responder agora (sem chave, cota esgotada ou provedor fora do ar). O sistema segue funcionando normalmente.",
  },
};

export const ENV_DISABLED_MESSAGE =
  "A IA está desligada no servidor (AI_ENABLED). Peça ao responsável pela infraestrutura.";

export const AI_DISCLAIMER = "Conteúdo gerado por IA pode conter erros. A IA é consultiva e não altera dados.";

/** Mesmo texto das outras telas ADM para 403 (perfil ou AAL2 ausente). */
const FORBIDDEN_MESSAGE =
  "Você não tem permissão para gerenciar a Inteligência Artificial, ou sua sessão ainda não confirmou a verificação em duas etapas (AAL2).";

export const CONFLICT_MESSAGE =
  "Outra pessoa alterou estas configurações enquanto você editava. Carregamos a versão mais recente: revise e salve novamente.";

function commonErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 0) return "Falha de rede ao comunicar com a API. Verifique sua conexão e tente novamente.";
  if (error.status === 401) return "Sessão não autenticada. Faça login novamente.";
  if (error.status === 403) return FORBIDDEN_MESSAGE;
  if (error.status === 429) return "Muitas tentativas em pouco tempo. Aguarde e tente novamente.";
  return null;
}

export function loadErrorMessage(error: unknown): string {
  return commonErrorMessage(error) ?? "Não foi possível carregar as configurações de IA. Tente novamente.";
}

export function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    if (error.code === "invalid_model") {
      return "O modelo escolhido não está na lista permitida para este provedor. Escolha outro modelo.";
    }
    if (error.code === "deepseek_ack_required") {
      return "Para usar o DeepSeek é preciso confirmar o aviso de transferência internacional de dados.";
    }
    return "O servidor recusou os dados enviados. Revise os campos e tente novamente.";
  }
  return commonErrorMessage(error) ?? "Não foi possível salvar as configurações agora. Tente novamente.";
}

export function testErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return "Limite de testes atingido (5 por hora). Tente novamente mais tarde.";
  }
  return commonErrorMessage(error) ?? "Não foi possível testar a conexão agora. Tente novamente.";
}

export function describeTestResult(response: AiTestResponse): {
  state: StatusIndicatorState;
  label: string;
  detail: string;
} {
  switch (response.result) {
    case "ok":
      return {
        state: "success",
        label: "Conexão funcionando",
        detail:
          typeof response.latency_ms === "number"
            ? `O provedor respondeu em ${response.latency_ms} ms.`
            : "O provedor respondeu normalmente.",
      };
    case "disabled":
      return {
        state: "idle",
        label: "IA desligada",
        detail: "Ligue a IA e salve antes de testar. (Se ela já estiver ligada aqui, pode estar desligada no servidor.)",
      };
    case "not_configured":
      return {
        state: "warning",
        label: "Sem chave",
        detail: "Não há chave configurada no servidor para o provedor salvo, ou nenhum provedor foi escolhido.",
      };
    default:
      return {
        state: "warning",
        label: "Provedor indisponível",
        detail: "O provedor não respondeu agora. O sistema segue funcionando normalmente; tente mais tarde.",
      };
  }
}
