"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, KeyRound } from "lucide-react";

import { FadeIn, SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { StatusIndicator } from "@/components/ui/status-indicator";
import { AI_SETTINGS_QUERY_KEY, AiSettingsForm } from "@/components/features/settings/ai-settings-form";
import {
  AI_DISCLAIMER,
  CONFLICT_MESSAGE,
  describeTestResult,
  ENV_DISABLED_MESSAGE,
  loadErrorMessage,
  PROVIDER_LABEL,
  STATUS_TEXT,
  testErrorMessage,
} from "@/components/features/settings/ai-settings-labels";
import { ApiError } from "@/lib/api-client";
import { AI_PROVIDERS, getAiSettings, testAiConnection, type AiSettings } from "@/lib/ai-settings-api";

// =============================================================================
// /configuracoes/inteligencia-artificial — configuração da IA consultiva (ADM).
// =============================================================================
// Contrato: docs/architecture/modulo-configuracoes.md (Etapa 1). Todas as
// rotas exigem ADM + AAL2 + `settings.ai.manage` NO BACKEND; esta tela só
// apresenta o estado e trata os erros (403/409/400/429). O link do menu é
// oculto para USER/RH apenas por UX.
// Nenhuma chave é exibida: só "Configurada"/"Não configurada". O resultado do
// "Testar conexão" é o que o backend devolveu (nunca simulado/animado).
// =============================================================================

const DATE_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Araguaina",
  dateStyle: "short",
  timeStyle: "short",
});

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMAT.format(date);
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) return false;
  return failureCount < 1;
}

export default function InteligenciaArtificialPage() {
  const queryClient = useQueryClient();
  const [conflictNotice, setConflictNotice] = useState(false);

  const settingsQuery = useQuery({
    queryKey: AI_SETTINGS_QUERY_KEY,
    queryFn: getAiSettings,
    retry: shouldRetry,
  });

  const settings = settingsQuery.data;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Configurações</span>
        <h1 className="text-heading text-bone">Inteligência Artificial</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Escolha o provedor, o modelo e quais funcionalidades de IA ficam ligadas. A IA só recebe
          dados agregados e nunca é necessária para o sistema funcionar.
        </p>
      </div>

      <p className="flex max-w-3xl items-start gap-2 rounded-cards border border-ash-stroke px-4 py-3 text-body-sm text-pale-stone">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warm-granite" aria-hidden />
        <span>{AI_DISCLAIMER}</span>
      </p>

      {settingsQuery.isPending ? (
        <LoadingSkeleton
          variant="cards"
          count={3}
          label="Carregando configurações de IA…"
          className="max-w-3xl"
        />
      ) : null}

      {settingsQuery.isError ? (
        <SlideIn distance="sm" className="max-w-3xl">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>{loadErrorMessage(settingsQuery.error)}</FormMessage>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={settingsQuery.isFetching}
              onClick={() => settingsQuery.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      ) : null}

      {settings ? (
        <div className="flex max-w-3xl flex-col gap-6">
          {conflictNotice ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {CONFLICT_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          <div className="grid gap-6 md:grid-cols-2">
            <StatusCard settings={settings} />
            <KeysCard settings={settings} />
          </div>

          <AiSettingsForm
            key={settings.version}
            settings={settings}
            onSaved={() => setConflictNotice(false)}
            onConflict={() => {
              setConflictNotice(true);
              void queryClient.invalidateQueries({ queryKey: AI_SETTINGS_QUERY_KEY });
            }}
          />

          <ConnectionTestCard />
        </div>
      ) : null}
    </div>
  );
}

function StatusCard({ settings }: { settings: AiSettings }) {
  const status = STATUS_TEXT[settings.status];
  const updatedAt = formatDate(settings.updated_at);
  return (
    <section
      aria-labelledby="ia-estado-titulo"
      className="flex flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding"
    >
      <h2 id="ia-estado-titulo" className="text-body text-bone">
        Estado geral
      </h2>
      <StatusIndicator state={status.state} prefix="IA" label={status.label} />
      <p className="text-body-sm text-warm-granite">{status.detail}</p>
      {!settings.env_enabled ? (
        <p data-testid="ia-env-desligada" className="flex items-start gap-2 text-body-sm text-signal-orange">
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-signal-orange" aria-hidden />
          <span>{ENV_DISABLED_MESSAGE}</span>
        </p>
      ) : null}
      <dl className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-sm">
        <dt className="text-warm-granite">Provedor</dt>
        <dd className="text-bone">{PROVIDER_LABEL[settings.provider]}</dd>
        <dt className="text-warm-granite">Modelo</dt>
        <dd className="break-words text-bone [overflow-wrap:anywhere]">{settings.model ?? "—"}</dd>
        {updatedAt ? (
          <>
            <dt className="text-warm-granite">Atualizado</dt>
            <dd className="text-bone">{updatedAt}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function KeysCard({ settings }: { settings: AiSettings }) {
  const anyConfigured = AI_PROVIDERS.some((provider) => settings.keys[provider] === "configured");
  return (
    <section
      aria-labelledby="ia-chaves-titulo"
      className="flex flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding"
    >
      <h2 id="ia-chaves-titulo" className="text-body text-bone">
        Chaves por provedor
      </h2>
      <p className="text-body-sm text-warm-granite">
        As chaves ficam só no servidor e nunca são exibidas. Para cadastrar ou trocar uma chave,
        fale com o responsável pela infraestrutura.
      </p>
      <ul className="flex flex-col gap-2" aria-label="Situação das chaves">
        {AI_PROVIDERS.map((provider) => {
          const configured = settings.keys[provider] === "configured";
          return (
            <li key={provider} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body-sm text-bone">{PROVIDER_LABEL[provider]}</span>
              <Badge variant={configured ? "success" : "default"}>
                {configured ? "Configurada" : "Não configurada"}
              </Badge>
            </li>
          );
        })}
      </ul>
      {!anyConfigured ? (
        <EmptyState
          variant="plain"
          icon={KeyRound}
          title="Nenhuma chave configurada"
          description="Sem chave, a IA permanece indisponível e o sistema funciona normalmente."
          className="px-0 py-2"
        />
      ) : null}
    </section>
  );
}

function ConnectionTestCard() {
  const test = useMutation({ mutationFn: testAiConnection });
  const outcome = test.data ? describeTestResult(test.data) : null;

  return (
    <section
      aria-labelledby="ia-teste-titulo"
      className="flex flex-col gap-3 rounded-cards border border-ash-stroke p-card-padding"
    >
      <h2 id="ia-teste-titulo" className="text-body text-bone">
        Testar conexão
      </h2>
      <p className="text-body-sm text-warm-granite">
        Usa a configuração salva e envia apenas um texto fixo, sem nenhum dado do sistema. Limite
        de 5 testes por hora.
      </p>
      <Button
        variant="outline"
        className="self-start"
        loading={test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending ? "Testando…" : "Testar conexão"}
      </Button>
      <div aria-live="polite" className="flex flex-col gap-1">
        {test.isPending ? <StatusIndicator state="loading" label="Testando conexão…" live={false} /> : null}
        {!test.isPending && outcome ? (
          <FadeIn className="flex flex-col gap-1">
            <StatusIndicator state={outcome.state} label={outcome.label} live={false} />
            <p className="text-body-sm text-warm-granite">{outcome.detail}</p>
          </FadeIn>
        ) : null}
        {!test.isPending && test.isError ? <FormMessage>{testErrorMessage(test.error)}</FormMessage> : null}
      </div>
    </section>
  );
}
