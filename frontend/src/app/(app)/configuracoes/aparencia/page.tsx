"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";

import { SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { AppearanceForm } from "@/components/features/appearance/appearance-form";
import {
  CONFLICT_MESSAGE,
  loadErrorMessage,
  THEME_NOTICE,
  THEME_NOTICE_DETAIL,
} from "@/components/features/appearance/appearance-labels";
import { MY_PREFERENCES_QUERY_KEY, useMyPreferences } from "@/lib/use-my-preferences";

// =============================================================================
// /configuracoes/aparencia — densidade e tamanho de fonte (qualquer perfil).
// =============================================================================
// Contrato: GET/PATCH /api/v1/me/preferences (só o próprio usuário; `version`
// obrigatório, 409 em conflito). O backend é a fonte de verdade; o cookie
// `sispat-ui` (não sensível) só evita o flash no primeiro paint e é gravado
// depois de GET/PATCH bem-sucedidos (ver `src/lib/ui-preferences.ts`).
// Tema fixo: Factory dark é o único oficial no DESIGN.md.
// =============================================================================

export default function AparenciaPage() {
  const queryClient = useQueryClient();
  const [conflictNotice, setConflictNotice] = useState(false);
  const query = useMyPreferences();
  const prefs = query.data;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Configurações</span>
        <h1 className="text-heading text-bone">Aparência</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Ajuste a densidade da interface e o tamanho da fonte. A preferência fica salva na sua conta e vale em
          qualquer dispositivo.
        </p>
      </div>

      <p className="flex max-w-3xl items-start gap-2 rounded-cards border border-ash-stroke px-4 py-3 text-body-sm text-pale-stone">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warm-granite" aria-hidden />
        <span>
          <strong className="font-regular text-bone">{THEME_NOTICE}</strong> {THEME_NOTICE_DETAIL}
        </span>
      </p>

      {query.isPending ? (
        <LoadingSkeleton
          variant="cards"
          count={2}
          label="Carregando preferências de aparência…"
          className="max-w-3xl"
        />
      ) : null}

      {query.isError ? (
        <SlideIn distance="sm" className="max-w-3xl">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>{loadErrorMessage(query.error)}</FormMessage>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={query.isFetching}
              onClick={() => query.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      ) : null}

      {prefs ? (
        <div className="flex max-w-3xl flex-col gap-6">
          {conflictNotice ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {CONFLICT_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          <AppearanceForm
            key={prefs.version}
            prefs={prefs}
            onSaved={() => setConflictNotice(false)}
            onConflict={() => {
              setConflictNotice(true);
              void queryClient.invalidateQueries({ queryKey: MY_PREFERENCES_QUERY_KEY });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
