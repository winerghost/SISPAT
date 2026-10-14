"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api-client";
import {
  AI_FEATURE_KEYS,
  AI_MONTHLY_TOKEN_CAP_MAX,
  updateAiSettings,
  type AiFeatures,
  type AiProvider,
  type AiSettings,
  type AiSettingsUpdate,
} from "@/lib/ai-settings-api";
import { DeepseekTransferDialog } from "./deepseek-transfer-dialog";
import { FEATURE_TEXT, PROVIDER_LABEL, saveErrorMessage } from "./ai-settings-labels";

// =============================================================================
// Formulário de configuração da IA (ADM). Rascunho local inicializado a partir
// do GET; o pai o remonta (`key={version}`) sempre que o backend devolve uma
// versão nova — a tela só mostra o que o servidor confirmou.
// - Modelos: SOMENTE `settings.models[provider]` (allowlist do backend).
// - DeepSeek sem aceite prévio: abre o aviso LGPD antes de trocar o provedor;
//   confirmado, o PATCH leva `acknowledge_international_transfer: true`.
// - 409 → `onConflict` (o pai recarrega e avisa). Demais erros: mensagem local.
// Validação aqui é só UX; o backend (Pydantic, extra="forbid") decide.
// =============================================================================

export const AI_SETTINGS_QUERY_KEY = ["settings", "ai"] as const;

const PROVIDER_OPTIONS: AiProvider[] = ["none", "openai", "anthropic", "deepseek"];

interface Draft {
  enabled: boolean;
  provider: AiProvider;
  model: string | null;
  features: AiFeatures;
  cap: string;
}

function draftFrom(settings: AiSettings): Draft {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    features: { ...settings.features },
    cap: String(settings.monthly_token_cap),
  };
}

function modelsFor(settings: AiSettings, provider: AiProvider): string[] {
  return provider === "none" ? [] : (settings.models[provider] ?? []);
}

function parseCap(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n <= AI_MONTHLY_TOKEN_CAP_MAX ? n : null;
}

export interface AiSettingsFormProps {
  settings: AiSettings;
  onConflict: () => void;
  onSaved: () => void;
}

export function AiSettingsForm({ settings, onConflict, onSaved }: AiSettingsFormProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [ackAccepted, setAckAccepted] = useState(false);
  const [deepseekDialogOpen, setDeepseekDialogOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const models = modelsFor(settings, draft.provider);
  const capValue = parseCap(draft.cap);
  const capError =
    capValue === null ? "Informe um número inteiro de 0 a 50.000.000 tokens." : null;

  const dirty = useMemo(() => {
    const initial = draftFrom(settings);
    return (
      initial.enabled !== draft.enabled ||
      initial.provider !== draft.provider ||
      initial.model !== draft.model ||
      initial.cap !== draft.cap.trim() ||
      AI_FEATURE_KEYS.some((key) => initial.features[key] !== draft.features[key])
    );
  }, [settings, draft]);

  const mutation = useMutation({
    mutationFn: updateAiSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(AI_SETTINGS_QUERY_KEY, saved);
      toast.success("Configurações de IA salvas.");
      onSaved();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        onConflict();
        return;
      }
      if (error instanceof ApiError && error.code === "deepseek_ack_required") {
        setAckAccepted(false);
      }
      setSaveError(saveErrorMessage(error));
    },
  });

  function applyProvider(next: AiProvider) {
    setDraft((prev) => {
      const list = modelsFor(settings, next);
      const model = next === "none" ? null : prev.model && list.includes(prev.model) ? prev.model : (list[0] ?? null);
      return { ...prev, provider: next, model };
    });
  }

  function handleProviderChange(next: AiProvider) {
    setSaveError(null);
    if (next === "deepseek" && !settings.deepseek_acknowledged && !ackAccepted) {
      // O <select> é controlado: continua no provedor anterior até o aceite.
      setDeepseekDialogOpen(true);
      return;
    }
    applyProvider(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (capValue === null || mutation.isPending) return;
    setSaveError(null);
    const body: AiSettingsUpdate = {
      version: settings.version,
      enabled: draft.enabled,
      provider: draft.provider,
      features: { ...draft.features },
      monthly_token_cap: capValue,
    };
    if (draft.provider !== "none" && draft.model) body.model = draft.model;
    if (draft.provider === "deepseek" && !settings.deepseek_acknowledged && ackAccepted) {
      body.acknowledge_international_transfer = true;
    }
    mutation.mutate(body);
  }

  const pending = mutation.isPending;
  const providerKeyState = draft.provider === "none" ? null : settings.keys[draft.provider];

  return (
    <>
      <form
        noValidate
        onSubmit={handleSubmit}
        aria-labelledby="ia-form-titulo"
        className="flex flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
      >
        <h2 id="ia-form-titulo" className="text-body text-bone">
          Configuração
        </h2>

        <Switch
          label="Ligar a Inteligência Artificial"
          description="Liga ou desliga todas as funcionalidades de IA de uma vez. Desligada, o sistema funciona normalmente."
          checked={draft.enabled}
          disabled={pending}
          onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, enabled: checked }))}
        />

        <div className="grid gap-6 md:grid-cols-2">
          <FormField
            label="Provedor"
            hint={
              providerKeyState
                ? `Chave no servidor: ${providerKeyState === "configured" ? "configurada" : "não configurada"}.`
                : "Sem provedor, nenhuma solicitação de IA é enviada."
            }
          >
            {(field) => (
              <select
                {...field}
                value={draft.provider}
                disabled={pending}
                onChange={(event) => handleProviderChange(event.target.value as AiProvider)}
                className={selectControlClassName}
              >
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABEL[provider]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField
            label="Modelo"
            hint={
              draft.provider === "none"
                ? "Escolha um provedor para ver os modelos permitidos."
                : models.length === 0
                  ? "Nenhum modelo liberado pelo servidor para este provedor."
                  : "Somente os modelos liberados pelo servidor aparecem aqui."
            }
          >
            {(field) => (
              <select
                {...field}
                value={draft.model ?? ""}
                disabled={pending || models.length === 0}
                onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                className={selectControlClassName}
              >
                {models.length === 0 ? <option value="">—</option> : null}
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>

        {draft.provider === "deepseek" ? (
          <p className="flex items-start gap-2 text-caption leading-[1.4] text-pale-stone">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-signal-orange" aria-hidden />
            {settings.deepseek_acknowledged
              ? "Aceite de transferência internacional de dados (LGPD) já registrado."
              : "Aceite de transferência internacional confirmado; será registrado ao salvar."}
          </p>
        ) : null}

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-4 text-eyebrow text-pale-stone">Funcionalidades</legend>
          {AI_FEATURE_KEYS.map((key) => (
            <Switch
              key={key}
              label={FEATURE_TEXT[key].label}
              description={FEATURE_TEXT[key].description}
              checked={draft.features[key]}
              disabled={pending}
              onCheckedChange={(checked) =>
                setDraft((prev) => ({ ...prev, features: { ...prev.features, [key]: checked } }))
              }
            />
          ))}
        </fieldset>

        <FormField
          label="Teto mensal de tokens"
          hint="Ao atingir o teto, a IA fica indisponível até o mês seguinte. Use 0 para bloquear o uso."
          error={capError}
          className="max-w-xs"
        >
          {(field) => (
            <Input
              {...field}
              type="number"
              inputMode="numeric"
              min={0}
              max={AI_MONTHLY_TOKEN_CAP_MAX}
              step={1000}
              value={draft.cap}
              disabled={pending}
              onChange={(event) => setDraft((prev) => ({ ...prev, cap: event.target.value }))}
            />
          )}
        </FormField>

        {saveError ? (
          <SlideIn distance="sm">
            <FormMessage>{saveError}</FormMessage>
          </SlideIn>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending} disabled={!dirty || capValue === null}>
            {pending ? "Salvando…" : "Salvar"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || pending}
            onClick={() => {
              setDraft(draftFrom(settings));
              setAckAccepted(false);
              setSaveError(null);
            }}
          >
            Descartar alterações
          </Button>
        </div>
      </form>

      <DeepseekTransferDialog
        open={deepseekDialogOpen}
        onCancel={() => setDeepseekDialogOpen(false)}
        onConfirm={() => {
          setAckAccepted(true);
          setDeepseekDialogOpen(false);
          applyProvider("deepseek");
        }}
      />
    </>
  );
}
