"use client";

import { useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";

import { FadeIn, StaggerContainer, StaggerItem } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { textareaControlClassName } from "@/components/ui/form-field";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import {
  AI_QUESTION_MAX,
  INSIGHT_KINDS,
  isForbiddenError,
  isRateLimitedError,
  useAiInsights,
  useAskAi,
  type AiInsight,
  type InsightKind,
} from "@/lib/ai-insights-api";
import { cn } from "@/lib/utils";

// =============================================================================
// Widgets de IA consultiva na Home (Etapa 4b).
// - Saída de IA = texto PURO (whitespace-pre-wrap, escapado pelo React): sem
//   markdown, HTML ou links. Rótulo permanente "Gerado por IA — pode conter erros".
// - Falha/indisponibilidade da IA é estado neutro: Home e alertas seguem normais.
// - Nada de pergunta/resposta em storage; números só os do backend (sem animar).
// - Esconder a caixa em 403 é só UX; a autorização é do backend.
// =============================================================================

export const AI_DISCLAIMER = "Gerado por IA — pode conter erros";

const KIND_LABEL: Record<InsightKind, string> = {
  alert_priority: "Prioridade dos alertas",
  executive_summary: "Resumo executivo",
  quality_suggestion: "Sugestões de qualidade de dados",
};

function formatGeneratedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Araguaina",
  }).format(date);
}

function Disclaimer() {
  return (
    <p data-ai-disclaimer className="flex items-center gap-2 text-eyebrow text-pale-stone">
      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {AI_DISCLAIMER}
    </p>
  );
}

function Unavailable() {
  return (
    <div data-ai-unavailable className="flex flex-col gap-1 p-4 sm:p-6">
      <p className="text-body text-bone">Insights de IA indisponíveis</p>
      <p className="text-body-sm text-warm-granite">
        O restante do painel continua funcionando normalmente.
      </p>
    </div>
  );
}

function groupByKind(items: AiInsight[]): { kind: InsightKind; items: AiInsight[] }[] {
  return INSIGHT_KINDS.map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) })).filter(
    (group) => group.items.length > 0,
  );
}

export function AiInsightsWidget({ className }: { className?: string }) {
  const query = useAiInsights();
  const generatedAt = query.data ? formatGeneratedAt(query.data.generated_at) : null;
  const groups = query.data?.status === "ok" ? groupByKind(query.data.items) : [];

  return (
    <section
      aria-labelledby="insights-de-ia"
      data-ai-insights-widget
      className={cn("overflow-hidden rounded-cards border border-ash-stroke", className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-carbon-lift px-4 py-3 sm:px-6">
        <h2 id="insights-de-ia" className="text-eyebrow text-bone">
          Insights de IA
        </h2>
        {generatedAt ? <span className="text-eyebrow text-pale-stone">Atualizado em {generatedAt}</span> : null}
      </header>

      {query.isPending ? (
        <div className="p-4 sm:p-6">
          <LoadingSkeleton variant="lines" count={3} label="Carregando insights de IA" />
        </div>
      ) : query.isError || query.data.status === "unavailable" || groups.length === 0 ? (
        <FadeIn>
          <Unavailable />
        </FadeIn>
      ) : (
        <div className="flex flex-col">
          <div className="border-b border-carbon-lift px-4 py-3 sm:px-6">
            <Disclaimer />
          </div>
          <StaggerContainer className="m-0 flex list-none flex-col p-0">
            {groups.map((group, index) => (
              <StaggerItem
                key={group.kind}
                index={index}
                data-insight-kind={group.kind}
                className="flex flex-col gap-3 border-b border-carbon-lift px-4 py-4 last:border-b-0 sm:px-6"
              >
                <h3 className="text-eyebrow text-pale-stone">{KIND_LABEL[group.kind]}</h3>
                {group.items.map((item, i) => (
                  <div key={`${item.title}:${i}`} className="flex min-w-0 flex-col gap-1">
                    {item.title ? <h4 className="break-words text-body text-bone">{item.title}</h4> : null}
                    <p className="max-w-prose whitespace-pre-wrap break-words text-body-sm text-warm-granite">
                      {item.text}
                    </p>
                  </div>
                ))}
              </StaggerItem>
            ))}
          </StaggerContainer>
        </div>
      )}
    </section>
  );
}

export function AskSispatBox({ className }: { className?: string }) {
  const insights = useAiInsights();
  const mutation = useAskAi();
  const [question, setQuestion] = useState("");
  const sending = useRef(false);

  const trimmed = question.trim();
  const forbidden = isForbiddenError(insights.error) || isForbiddenError(mutation.error);
  if (forbidden) return null;

  const canSend = trimmed.length > 0 && trimmed.length <= AI_QUESTION_MAX && !mutation.isPending;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || sending.current) return;
    sending.current = true;
    mutation.mutate(trimmed, {
      onSettled: () => {
        sending.current = false;
      },
    });
  }

  const rateLimited = isRateLimitedError(mutation.error);
  const failed = mutation.isError && !rateLimited;
  const answer = mutation.data;

  return (
    <section
      aria-labelledby="pergunte-ao-sispat"
      data-ask-sispat
      className={cn("overflow-hidden rounded-cards border border-ash-stroke", className)}
    >
      <header className="border-b border-carbon-lift px-4 py-3 sm:px-6">
        <h2 id="pergunte-ao-sispat" className="text-eyebrow text-bone">
          Pergunte ao SISPAT
        </h2>
      </header>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <Disclaimer />
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <label htmlFor="pergunta-sispat" className="text-eyebrow text-pale-stone">
            Sua pergunta
          </label>
          <textarea
            id="pergunta-sispat"
            name="question"
            rows={3}
            maxLength={AI_QUESTION_MAX}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={mutation.isPending}
            autoComplete="off"
            aria-describedby="pergunta-sispat-contador"
            placeholder="Ex.: quantos bens estão sem responsável?"
            className={cn(textareaControlClassName, "resize-y")}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span id="pergunta-sispat-contador" data-ask-counter className="text-caption text-warm-granite">
              {question.length}/{AI_QUESTION_MAX} caracteres
            </span>
            <Button type="submit" disabled={!canSend} loading={mutation.isPending}>
              {mutation.isPending ? "Enviando…" : "Enviar pergunta"}
            </Button>
          </div>
        </form>

        {mutation.isPending ? (
          <p role="status" className="text-body-sm text-warm-granite">
            Consultando a IA…
          </p>
        ) : null}

        {rateLimited ? (
          <FadeIn role="alert" data-ask-rate-limited className="flex items-start gap-2 text-body-sm text-bone">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            Limite atingido, tente mais tarde.
          </FadeIn>
        ) : null}

        {failed ? (
          <FadeIn role="alert" data-ask-error className="flex items-start gap-2 text-body-sm text-bone">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-orange" aria-hidden="true" />
            Não foi possível obter a resposta agora. Tente novamente.
          </FadeIn>
        ) : null}

        {answer?.status === "unavailable" ? (
          <FadeIn role="status" data-ask-unavailable className="text-body-sm text-warm-granite">
            Insights de IA indisponíveis
          </FadeIn>
        ) : null}

        {answer?.status === "ok" ? (
          <FadeIn
            role="status"
            data-ask-answer
            className="flex min-w-0 flex-col gap-2 border-t border-carbon-lift pt-4"
          >
            <span className="text-eyebrow text-pale-stone">Resposta</span>
            <p className="max-w-prose whitespace-pre-wrap break-words text-body-sm text-bone">{answer.answer}</p>
            {answer.tools_used.length > 0 ? (
              <p data-ask-tools className="break-words text-caption text-warm-granite">
                Consultas informadas pela IA (não verificadas): {answer.tools_used.join(", ")}
              </p>
            ) : null}
          </FadeIn>
        ) : null}
      </div>
    </section>
  );
}
