"use client";

import { useEffect, useId, useState, type ChangeEvent } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { FadeIn, SlideIn } from "@/components/animations";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { StatusIndicator } from "@/components/ui/status-indicator";
import { cn } from "@/lib/utils";
import {
  AVATAR_ACCEPTED_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarUploadResponse,
  type AvatarUrlResponse,
} from "@/lib/users-api";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { Avatar, useSignedAvatarUrl } from "./user-avatar";
import { isNotFound, userErrorMessage } from "./user-labels";

// =============================================================================
// Foto de perfil — envio, pré-visualização e remoção. Usado pela gestão de
// usuários (ADM: /users/<id>/avatar*) e por "Meu perfil" (/me/avatar*).
// - Pré-visualização LOCAL via `URL.createObjectURL` (revogada ao trocar,
//   cancelar ou desmontar); nada sai do navegador antes de "Enviar foto".
// - Tipo (JPEG/PNG/WebP) e tamanho (2 MB) checados aqui só como orientação:
//   o backend valida os bytes, recodifica para WebP 512×512 e remove EXIF.
// - Foto atual: URL assinada temporária (ver `useSignedAvatarUrl`).
// - 503 `storage_unavailable` → aviso claro; o resto da tela segue normal.
// =============================================================================

export interface AvatarManagerProps {
  name: string;
  /** `undefined` = desconhecido (descobre pela URL: 404 = sem foto). */
  hasAvatar: boolean | undefined;
  urlQueryKey: QueryKey;
  fetchUrl: () => Promise<AvatarUrlResponse>;
  upload: (file: File) => Promise<AvatarUploadResponse>;
  remove: () => Promise<unknown>;
  /** Chamado após o backend confirmar envio/remoção. */
  onChanged?: (hasAvatar: boolean) => void;
  /** Ex.: "sua foto" / "a foto de Fulana". */
  subject: string;
}

function clientValidation(file: File): string | null {
  if (!(AVATAR_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return "Formato não aceito. Escolha uma foto JPEG, PNG ou WebP.";
  }
  if (file.size > AVATAR_MAX_BYTES) return "A foto deve ter no máximo 2 MB.";
  if (file.size === 0) return "O arquivo escolhido está vazio.";
  return null;
}

export function AvatarManager({
  name,
  hasAvatar,
  urlQueryKey,
  fetchUrl,
  upload,
  remove,
  onChanged,
  subject,
}: AvatarManagerProps) {
  const queryClient = useQueryClient();
  const inputId = `foto-${useId().replace(/:/g, "")}`;
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const url = useSignedAvatarUrl(urlQueryKey, fetchUrl, hasAvatar !== false);
  const currentExists = hasAvatar === true || (hasAvatar === undefined && !!url.data);
  const urlError = url.isError && !isNotFound(url.error) ? url.error : null;

  // Revoga o blob: anterior sempre que a pré-visualização muda ou o componente sai.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function clearPending() {
    setFile(null);
    setPreviewUrl(null);
  }

  const uploadMutation = useMutation({
    mutationFn: (chosen: File) => upload(chosen),
    onSuccess: () => {
      clearPending();
      setError(null);
      toast.success("Foto atualizada.");
      void queryClient.invalidateQueries({ queryKey: urlQueryKey });
      onChanged?.(true);
    },
    onError: (cause) => setError(userErrorMessage(cause, "Não foi possível enviar a foto agora. Tente novamente.")),
  });

  const removeMutation = useMutation({
    mutationFn: () => remove(),
    onSuccess: () => {
      setConfirmRemove(false);
      setError(null);
      toast.success("Foto removida.");
      queryClient.removeQueries({ queryKey: urlQueryKey });
      onChanged?.(false);
    },
    onError: (cause) => setError(userErrorMessage(cause, "Não foi possível remover a foto agora. Tente novamente.")),
  });

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    // Permite escolher o mesmo arquivo de novo depois de cancelar.
    event.target.value = "";
    if (!chosen) return;
    const problem = clientValidation(chosen);
    if (problem) {
      clearPending();
      setError(problem);
      return;
    }
    setError(null);
    setFile(chosen);
    setPreviewUrl(URL.createObjectURL(chosen));
  }

  const busy = uploadMutation.isPending || removeMutation.isPending;
  const shownSrc = previewUrl ?? (currentExists ? url.data?.url : null);

  return (
    <section aria-labelledby={`${inputId}-titulo`} className="flex flex-col gap-4">
      <h3 id={`${inputId}-titulo`} className="text-body text-bone">
        Foto de perfil
      </h3>

      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={name} src={shownSrc} size="lg" onImageError={() => void url.refetch()} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-body-sm text-warm-granite">
          {previewUrl ? (
            <p className="text-bone">Pré-visualização — a foto ainda não foi enviada.</p>
          ) : currentExists ? (
            <p>Foto atual.</p>
          ) : url.isFetching ? (
            <StatusIndicator state="loading" label="Carregando foto…" />
          ) : (
            <p>Sem foto — as iniciais são exibidas no lugar.</p>
          )}
          <p className="text-caption leading-[1.4]">
            JPEG, PNG ou WebP, até 2 MB. A imagem é recortada em 512×512 e os metadados (como localização)
            são removidos no servidor.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          id={inputId}
          type="file"
          accept={AVATAR_ACCEPTED_TYPES.join(",")}
          onChange={handleFile}
          disabled={busy}
          className="peer sr-only"
        />
        <label
          htmlFor={inputId}
          className={cn(
            "inline-flex h-9 cursor-pointer items-center gap-2 rounded-buttons border border-ash-stroke px-[14px] text-body-sm text-bone transition-factory hover:bg-carbon-lift",
            "peer-focus-visible:ring-1 peer-focus-visible:ring-bone peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-obsidian-canvas",
            busy && "pointer-events-none opacity-50",
          )}
        >
          <ImagePlus className="h-4 w-4" aria-hidden />
          {currentExists || previewUrl ? "Escolher outra foto" : "Escolher foto"}
        </label>

        {file ? (
          <>
            <Button loading={uploadMutation.isPending} onClick={() => uploadMutation.mutate(file)}>
              {uploadMutation.isPending ? "Enviando…" : "Enviar foto"}
            </Button>
            <Button variant="ghost" onClick={clearPending} disabled={busy}>
              Descartar
            </Button>
          </>
        ) : currentExists ? (
          <Button
            variant="destructive"
            onClick={() => {
              setError(null);
              setConfirmRemove(true);
            }}
            disabled={busy}
          >
            <Trash2 aria-hidden />
            Remover foto
          </Button>
        ) : null}
      </div>

      <div aria-live="polite">
        {error ? (
          <SlideIn distance="sm">
            <FormMessage>{error}</FormMessage>
          </SlideIn>
        ) : urlError ? (
          <FadeIn>
            <FormMessage>{userErrorMessage(urlError, "Não foi possível carregar a foto atual.")}</FormMessage>
          </FadeIn>
        ) : null}
      </div>

      <ConfirmActionDialog
        open={confirmRemove}
        onOpenChange={(open) => {
          setConfirmRemove(open);
          if (!open) setError(null);
        }}
        title="Remover foto"
        description={`Remover ${subject}?`}
        consequences={[
          "A foto é apagada do armazenamento e deixa de aparecer no sistema.",
          "As iniciais do nome passam a ser exibidas no lugar.",
          "Uma nova foto pode ser enviada a qualquer momento.",
        ]}
        confirmLabel="Remover foto"
        pendingLabel="Removendo…"
        pending={removeMutation.isPending}
        error={confirmRemove ? error : null}
        onConfirm={() => removeMutation.mutate()}
      />
    </section>
  );
}
