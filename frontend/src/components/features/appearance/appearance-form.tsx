"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { ApiError } from "@/lib/api-client";
import { updateMyPreferences, type MyPreferences, type MyPreferencesUpdate } from "@/lib/preferences-api";
import { persistUiPreferences, type Density, type FontScale } from "@/lib/ui-preferences";
import { MY_PREFERENCES_QUERY_KEY } from "@/lib/use-my-preferences";
import { AppearancePreview } from "./appearance-preview";
import { DENSITY_OPTIONS, FONT_SCALE_OPTIONS, saveErrorMessage } from "./appearance-labels";
import { OptionRadioGroup } from "./option-radio-group";

// =============================================================================
// Formulário de Aparência. Rascunho local inicializado a partir do GET; o pai
// o remonta (`key={version}`) sempre que o backend devolve uma versão nova.
// A interface só muda de verdade (cookie `sispat-ui` + atributos no <html>)
// DEPOIS de o PATCH ser confirmado — a escolha do rascunho aparece apenas na
// prévia. 409 -> `onConflict` (o pai recarrega e avisa).
// =============================================================================

export interface AppearanceFormProps {
  prefs: MyPreferences;
  onConflict: () => void;
  onSaved: () => void;
}

export function AppearanceForm({ prefs, onConflict, onSaved }: AppearanceFormProps) {
  const queryClient = useQueryClient();
  const [density, setDensity] = useState<Density>(prefs.density);
  const [fontScale, setFontScale] = useState<FontScale>(prefs.font_scale);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = density !== prefs.density || fontScale !== prefs.font_scale;

  const mutation = useMutation({
    mutationFn: updateMyPreferences,
    onSuccess: (saved) => {
      persistUiPreferences(saved);
      queryClient.setQueryData(MY_PREFERENCES_QUERY_KEY, saved);
      toast.success("Preferências de aparência salvas.");
      onSaved();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        onConflict();
        return;
      }
      setSaveError(saveErrorMessage(error));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || mutation.isPending) return;
    setSaveError(null);
    const body: MyPreferencesUpdate = { version: prefs.version };
    if (density !== prefs.density) body.density = density;
    if (fontScale !== prefs.font_scale) body.font_scale = fontScale;
    mutation.mutate(body);
  }

  const pending = mutation.isPending;

  return (
    <>
      <form
        noValidate
        onSubmit={handleSubmit}
        aria-labelledby="aparencia-form-titulo"
        className="flex flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
      >
        <h2 id="aparencia-form-titulo" className="text-body text-bone">
          Preferências
        </h2>

        <OptionRadioGroup
          legend="Densidade"
          name="density"
          options={DENSITY_OPTIONS}
          value={density}
          disabled={pending}
          onChange={(next) => {
            setSaveError(null);
            setDensity(next);
          }}
        />

        <OptionRadioGroup
          legend="Tamanho da fonte"
          name="font_scale"
          options={FONT_SCALE_OPTIONS}
          value={fontScale}
          disabled={pending}
          onChange={(next) => {
            setSaveError(null);
            setFontScale(next);
          }}
        />

        {saveError ? (
          <SlideIn distance="sm">
            <FormMessage>{saveError}</FormMessage>
          </SlideIn>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending} disabled={!dirty}>
            {pending ? "Salvando…" : "Salvar"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || pending}
            onClick={() => {
              setDensity(prefs.density);
              setFontScale(prefs.font_scale);
              setSaveError(null);
            }}
          >
            Descartar alterações
          </Button>
        </div>
      </form>

      <AppearancePreview density={density} fontScale={fontScale} />
    </>
  );
}
