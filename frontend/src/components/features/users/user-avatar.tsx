"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { getUserAvatarUrl, type AvatarUrlResponse } from "@/lib/users-api";
import { initialsOf } from "./user-labels";

// =============================================================================
// Avatar de usuário — foto (URL assinada do bucket privado) ou iniciais.
// =============================================================================
// A URL assinada só é pedida quando o avatar é EXIBIDO e a pessoa tem foto
// (`has_avatar`). Ela nunca fica guardada além do `expires_in` devolvido pelo
// backend: `gcTime: 0` descarta o cache assim que nenhum avatar a usa, e,
// enquanto exibida, é renovada 30 s antes de expirar. Se a imagem falhar (URL
// expirada, Storage fora do ar), mostramos as iniciais — nunca quebra a tela.
// Na LISTA (`lazy`, UA-FE-02): a URL só é pedida quando a linha está visível
// (IntersectionObserver) e NUNCA é renovada em segundo plano; se expirar ou
// falhar, ficam as iniciais e um novo pedido só ocorre quando a linha voltar
// a ficar visível — protege o limite de `avatar-url` (600/h por ADM).
// Raio de 3px (DESIGN.md: o sistema "não é macio"); sem sombra.
// =============================================================================

const RENEW_MARGIN_MS = 30_000;
const MIN_REFRESH_MS = 15_000;

function lifetimeMs(data: AvatarUrlResponse | undefined): number {
  if (!data || !Number.isFinite(data.expires_in)) return 0;
  return Math.max(MIN_REFRESH_MS, data.expires_in * 1000 - RENEW_MARGIN_MS);
}

/**
 * URL assinada de avatar com validade respeitada (nunca cacheada além de
 * `expires_in`). `renew: false` desliga a renovação em segundo plano.
 */
export function useSignedAvatarUrl(
  queryKey: QueryKey,
  fetcher: () => Promise<AvatarUrlResponse>,
  enabled: boolean,
  { renew = true }: { renew?: boolean } = {},
) {
  return useQuery({
    queryKey,
    queryFn: fetcher,
    enabled,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: renew,
    staleTime: (query) => lifetimeMs(query.state.data as AvatarUrlResponse | undefined),
    refetchInterval: (query) => {
      if (!renew) return false;
      const data = query.state.data as AvatarUrlResponse | undefined;
      return data ? lifetimeMs(data) : false;
    },
  });
}

/** `true` enquanto o elemento está (ou entra) na área visível. */
function useIsVisible<T extends Element>(active: boolean) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  return { ref, visible };
}

export const userAvatarQueryKey = (userId: string) => ["users", "avatar-url", userId] as const;

const SIZE = {
  sm: "h-8 w-8 text-caption",
  md: "h-10 w-10 text-caption",
  lg: "h-24 w-24 text-body",
} as const;

export interface AvatarProps {
  name: string;
  /** URL já autorizada (assinada) ou `blob:` de pré-visualização local. */
  src?: string | null;
  size?: keyof typeof SIZE;
  className?: string;
  /** Chamado quando a imagem falha (ex.: URL expirada). */
  onImageError?: () => void;
  /** Ref do contêiner (ex.: para observar a visibilidade). */
  containerRef?: Ref<HTMLSpanElement>;
}

/** Avatar puramente visual (o nome sempre aparece em texto ao lado). */
export function Avatar({ name, src, size = "md", className, onImageError, containerRef }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = !!src && failedSrc !== src;
  return (
    <span
      ref={containerRef}
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-buttons border border-ash-stroke bg-carbon-lift font-mono uppercase text-pale-stone",
        SIZE[size],
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária do Storage privado ou blob: local; next/image cachearia além do expires_in
        <img
          src={src!}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => {
            setFailedSrc(src!);
            onImageError?.();
          }}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

/**
 * Avatar de um usuário administrado: busca a URL assinada só se `hasAvatar`.
 * `lazy` (lista): só quando visível e sem renovação em segundo plano.
 */
export function UserAvatar({
  userId,
  name,
  hasAvatar,
  size = "md",
  className,
  lazy = false,
}: {
  userId: string;
  name: string;
  hasAvatar: boolean;
  size?: keyof typeof SIZE;
  className?: string;
  lazy?: boolean;
}) {
  const queryClient = useQueryClient();
  const key = userAvatarQueryKey(userId);
  const { ref, visible } = useIsVisible<HTMLSpanElement>(lazy && hasAvatar);
  const url = useSignedAvatarUrl(key, () => getUserAvatarUrl(userId), hasAvatar && (!lazy || visible), {
    renew: !lazy,
  });
  return (
    <Avatar
      containerRef={ref}
      name={name}
      src={hasAvatar ? url.data?.url : null}
      size={size}
      className={className}
      onImageError={() => {
        // Lista: marca como vencida SEM buscar agora; o próximo pedido só
        // acontece quando a linha voltar a ficar visível.
        if (lazy) void queryClient.invalidateQueries({ queryKey: key, refetchType: "none" });
        else void url.refetch();
      }}
    />
  );
}
