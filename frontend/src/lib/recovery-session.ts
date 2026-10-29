"use client";

// =============================================================================
// SISPAT-AGU — recovery-session.ts  (correção F6)
// =============================================================================
// Uma sessão criada por LINK DE RECUPERAÇÃO DE SENHA não pode liberar o
// sistema. Antes desta correção, um link legado de recuperação caindo na raiz
// (`/#access_token=...&type=recovery`) era processado pelo SDK, virava sessão
// válida e o `AuthGuard` deixava a pessoa ENTRAR sem trocar a senha.
//
// Como se detecta: o supabase-js anuncia `PASSWORD_RECOVERY` (em vez de
// `SIGNED_IN`) quando a sessão veio de um link `type=recovery` — tanto no fluxo
// implícito (hash) quanto no `verifyOtp({ type: "recovery" })`. O observador é
// registrado no MESMO bloco síncrono da criação do cliente
// (`supabase-client.ts`), antes de o SDK processar a URL, para não existir
// janela em que o evento passe sem ouvinte.
//
// O que fica guardado: só o `access_token` da sessão de recuperação, em memória
// do módulo (nunca localStorage/sessionStorage/cookie, nunca logado). Ele serve
// para duas coisas:
//   1. o shell/guarda saberem que a sessão ATUAL é de recuperação (bloqueio);
//   2. `/ativar-conta` poder ADOTAR essa sessão quando a pessoa chega da raiz
//      sem credencial na URL — e somente ela: uma sessão preexistente (de outra
//      pessoa ou de outra aba) nunca é aceita para definir senha.
//
// Nada aqui é mecanismo de segurança do sistema (o backend é a autoridade):
// é a tela deixando de conceder acesso a quem só pediu "trocar senha".
// =============================================================================

import { useSyncExternalStore } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

let recoveryAccessToken: string | null = null;
let watching = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setRecoveryAccessToken(token: string | null): void {
  if (recoveryAccessToken === token) return;
  recoveryAccessToken = token;
  emit();
}

/**
 * Liga o observador de `PASSWORD_RECOVERY` (idempotente). Chamado por
 * `getSupabaseClient()` logo após `createClient`, de forma síncrona.
 */
export function watchRecoverySession(client: SupabaseClient): void {
  if (watching) return;
  watching = true;
  client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      setRecoveryAccessToken(session?.access_token ?? null);
      return;
    }
    // Logout (inclusive o `signOut` local do fim da redefinição) e login novo
    // encerram o estado de recuperação.
    if (event === "SIGNED_OUT" || event === "SIGNED_IN") setRecoveryAccessToken(null);
  });
}

/** `access_token` da sessão de recuperação detectada nesta carga, se houver. */
export function getRecoveryAccessToken(): string | null {
  return recoveryAccessToken;
}

/** `true` se a sessão informada é a sessão de recuperação detectada. */
export function isRecoverySession(session: Session | null | undefined): boolean {
  return !!recoveryAccessToken && !!session && session.access_token === recoveryAccessToken;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return recoveryAccessToken;
}

/**
 * Hook: a sessão informada é uma sessão de recuperação de senha? Usado pelo
 * shell (não mostra o chrome do app) e pelo AuthGuard (não renderiza conteúdo
 * protegido e manda para `/ativar-conta`).
 */
export function useIsRecoverySession(session: Session | null | undefined): boolean {
  const token = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return !!token && !!session && session.access_token === token;
}
