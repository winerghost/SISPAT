// =============================================================================
// SISPAT-AGU — supabase-client.ts
// =============================================================================
// Cliente Supabase do NAVEGADOR (singleton), usado para TUDO que é
// responsabilidade do Supabase Auth: login (signInWithPassword), MFA
// (enroll/challenge/listFactors — exceto REMOÇÃO de fator, ver abaixo),
// leitura/renovação de sessão e definição de senha após convite
// (updateUser). Nenhuma chamada a tabelas Postgres acontece por aqui.
//
// Sobre a ANON KEY (NEXT_PUBLIC_SUPABASE_ANON_KEY):
//   É PÚBLICA POR DESIGN. Diferente das tabelas do Postgres (protegidas por
//   RLS), o Supabase Auth valida cada operação sensível no próprio servidor
//   de autenticação a partir da sessão/senha/código do usuário que está
//   chamando — por isso é seguro embutir essa chave em qualquer bundle de
//   frontend. Ela NUNCA deve ser confundida com a Service Role Key
//   (`SUPABASE_SERVICE_ROLE_KEY`), que faz bypass de RLS e NUNCA existe (nem
//   deve existir) no frontend — essa chave vive exclusivamente no backend
//   Flask (ver `.env.example`).
//
// Sobre a remoção de fator MFA:
//   `supabase.auth.mfa.unenroll()` NUNCA deve ser chamado diretamente pelo
//   frontend. A remoção passa pelo backend
//   (`DELETE /api/v1/security/mfa/factors/{factor_id}`, ver `users-api.ts`)
//   para que a regra "ADM não pode remover o único fator ativo" (409) seja
//   respeitada — essa regra não pode ser garantida só pelo Supabase Auth.
//
// `detectSessionInUrl: true` (padrão do SDK, explicitado aqui) é o que
// permite a página `/ativar-conta` capturar a sessão a partir do link de
// convite do Supabase automaticamente — ver comentário detalhado em
// `app/ativar-conta/page.tsx`.
//
// Armazenamento da sessão (auditoria 2026-10-13, achado FE-SESS-1):
//   O padrão do supabase-js é `localStorage` (persiste após fechar o
//   navegador, compartilhado por todas as abas, legível por qualquer script
//   da origem). Aqui usamos `sessionStorage` (escopo da aba, apagado ao
//   fechar a aba) — reduz a janela de exposição do refresh token em estações
//   compartilhadas. Continua legível por JavaScript: a mitigação principal
//   contra roubo via XSS é a CSP com nonce (src/middleware.ts). A solução
//   definitiva (cookies via `@supabase/ssr`/BFF) está no plano do relatório
//   docs/security/evidence/frontend-security.md.
// =============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Chave própria (não a padrão `sb-<ref>-auth-token`) — facilita limpeza no logout. */
export const AUTH_STORAGE_KEY = "sispat-auth";

let cachedClient: SupabaseClient | undefined;

/**
 * Storage de sessão tolerante a falhas: `sessionStorage` quando disponível;
 * em memória quando o navegador bloqueia storage (modo privado restrito) ou
 * fora do navegador (SSR) — nunca `localStorage`.
 */
function createSessionStorageAdapter() {
  const memory = new Map<string, string>();
  const browserStorage = (): Storage | null => {
    try {
      return typeof window !== "undefined" ? window.sessionStorage : null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key: string): string | null {
      try {
        return browserStorage()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        const storage = browserStorage();
        if (storage) {
          storage.setItem(key, value);
          return;
        }
      } catch {
        /* cai para memória */
      }
      memory.set(key, value);
    },
    removeItem(key: string): void {
      memory.delete(key);
      try {
        browserStorage()?.removeItem(key);
      } catch {
        /* nada a fazer */
      }
    },
  };
}

/**
 * Remove qualquer resíduo de sessão Supabase do navegador (inclusive tokens
 * legados gravados em `localStorage` por versões anteriores deste cliente,
 * na chave padrão `sb-*-auth-token`). Chamado no logout.
 */
export function clearPersistedAuthState(): void {
  if (typeof window === "undefined") return;
  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[storageName];
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && (key.startsWith(AUTH_STORAGE_KEY) || /^sb-.*-auth-token/.test(key))) {
          keys.push(key);
        }
      }
      keys.forEach((key) => storage.removeItem(key));
    } catch {
      /* storage indisponível */
    }
  }
}

/**
 * Retorna o cliente Supabase do navegador (singleton — uma única instância
 * por sessão do navegador, para não duplicar listeners de
 * `onAuthStateChange` nem o storage de sessão).
 *
 * Lançar o erro de configuração ausente só na primeira chamada em runtime
 * (nunca no carregamento do módulo) evita quebrar o build do Next.js em
 * ambientes onde as variáveis ainda não foram preenchidas.
 */
export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Configuração do Supabase ausente: defina NEXT_PUBLIC_SUPABASE_URL e " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY no .env do frontend (ver .env.example).",
    );
  }

  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      storageKey: AUTH_STORAGE_KEY,
      storage: createSessionStorageAdapter(),
      autoRefreshToken: true,
      // Necessário para /ativar-conta: o SDK detecta e processa
      // automaticamente, no carregamento da página, tanto o formato
      // implícito (`#access_token=...` no hash) quanto o PKCE (`?code=...`
      // na query string) do link de convite/recuperação do Supabase.
      detectSessionInUrl: true,
    },
  });

  return cachedClient;
}
