"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { AvatarManager } from "@/components/features/users/avatar-manager";
import { useMe } from "@/lib/session";
import { deleteMyAvatar, getMyAvatarUrl, uploadMyAvatar } from "@/lib/users-api";

// =============================================================================
// /configuracoes/perfil — "Meu perfil" (qualquer perfil autenticado).
// =============================================================================
// Nome e e-mail vêm de `GET /api/v1/me` e são SOMENTE leitura (alterações
// cadastrais passam por um administrador). A foto usa `/api/v1/me/avatar*`
// — o backend identifica o usuário pela sessão; nenhum ID vai na URL.
// Presença da foto: `has_avatar` de `GET /me` (ausente = false); a URL
// assinada só é pedida quando há foto.
// =============================================================================

const MY_AVATAR_QUERY_KEY = ["me", "avatar-url"] as const;

export default function MeuPerfilPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  // Estado confirmado pelo backend após envio/remoção (antes: desconhecido).
  const [hasAvatar, setHasAvatar] = useState<boolean | undefined>(undefined);
  // UA-FE-01: `/me` informa `has_avatar`; ausente = sem foto (nada é inferido).
  const known = hasAvatar ?? me.data?.has_avatar === true;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Configurações</span>
        <h1 className="text-heading text-bone">Meu perfil</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Seus dados de identificação e sua foto. Para corrigir nome ou e-mail, fale com um administrador.
        </p>
      </div>

      {me.isPending ? <LoadingSkeleton variant="cards" count={2} label="Carregando seu perfil…" className="max-w-2xl" /> : null}

      {me.isError ? (
        <SlideIn distance="sm" className="max-w-2xl">
          <div className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 bg-carbon-lift p-card-padding">
            <FormMessage>Não foi possível carregar seu perfil. Tente novamente.</FormMessage>
            <Button variant="outline" size="sm" className="self-start" loading={me.isFetching} onClick={() => me.refetch()}>
              Tentar novamente
            </Button>
          </div>
        </SlideIn>
      ) : null}

      {me.data ? (
        <div className="flex max-w-2xl flex-col gap-6">
          <section
            aria-labelledby="perfil-dados-titulo"
            className="flex flex-col gap-4 rounded-cards border border-ash-stroke p-card-padding"
          >
            <h2 id="perfil-dados-titulo" className="text-body text-bone">
              Identificação
            </h2>
            <dl className="grid gap-x-4 gap-y-3 text-body-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-eyebrow text-pale-stone sm:pt-0.5">Nome</dt>
              <dd className="break-words text-bone [overflow-wrap:anywhere]">{me.data.name}</dd>
              <dt className="text-eyebrow text-pale-stone sm:pt-0.5">E-mail</dt>
              <dd className="break-words text-bone [overflow-wrap:anywhere]">{me.data.email}</dd>
              <dt className="text-eyebrow text-pale-stone sm:pt-0.5">Perfil</dt>
              <dd className="flex flex-wrap gap-1">
                {me.data.roles.length === 0 ? (
                  <span className="text-warm-granite">Sem perfil</span>
                ) : (
                  me.data.roles.map((role) => (
                    <Badge key={role} variant="outline">
                      {role}
                    </Badge>
                  ))
                )}
              </dd>
            </dl>
          </section>

          <div className="rounded-cards border border-ash-stroke p-card-padding">
            <AvatarManager
              name={me.data.name}
              hasAvatar={known}
              subject="sua foto de perfil"
              urlQueryKey={MY_AVATAR_QUERY_KEY}
              fetchUrl={getMyAvatarUrl}
              upload={uploadMyAvatar}
              remove={deleteMyAvatar}
              onChanged={(next) => {
                setHasAvatar(next);
                void queryClient.invalidateQueries({ queryKey: ["me"] });
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
