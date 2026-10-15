// =============================================================================
// SISPAT-AGU — mfa.ts
// =============================================================================
// Utilitários do fluxo de MFA (TOTP) no navegador.
//
// O segredo TOTP e o QR code retornados por `supabase.auth.mfa.enroll()`
// NUNCA devem ser logados (console), persistidos (storage) nem enviados a
// terceiros — vivem apenas no estado React da tela de enrollment e são
// descartados ao confirmar/cancelar.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

const SVG_DATA_URI_PREFIX = "data:image/svg+xml";

/**
 * Normaliza o QR code devolvido pelo Supabase para um data URI SVG seguro
 * para `<img src>`.
 *
 * - `@supabase/auth-js` >= 2.x já devolve `data:image/svg+xml;utf-8,<svg…>`;
 *   prefixar de novo gerava um URI inválido (QR quebrado).
 * - SVG cru (versões antigas) é codificado com `encodeURIComponent` — sem
 *   isso, `#`/`%` no SVG truncam/corrompem o URI.
 * - Qualquer outro valor (ex.: `javascript:`, `https:`) é rejeitado (`null`):
 *   a tela mostra só a chave manual.
 *
 * Em `<img>`, SVG não executa script; ainda assim, só aceitamos data URI SVG.
 */
export function toSafeQrCodeDataUri(qrCode: string | null | undefined): string | null {
  if (!qrCode) return null;
  const value = qrCode.trim();
  if (value.toLowerCase().startsWith(SVG_DATA_URI_PREFIX)) return value;
  if (value.startsWith("<svg") || value.startsWith("<?xml")) {
    return `${SVG_DATA_URI_PREFIX};charset=utf-8,${encodeURIComponent(value)}`;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Cadastro do PRIMEIRO fator TOTP (bootstrap do ADM, tela de login)
// -----------------------------------------------------------------------------
// O ADM exige MFA mas pode não ter nenhum fator (único administrador): sem este
// caminho a conta ficaria sem saída. O enroll usa a sessão AAL1 já autenticada;
// as rotas administrativas continuam exigindo AAL2 no backend (decisão sempre
// do backend). Segredo/QR retornados só circulam em memória do chamador.
// -----------------------------------------------------------------------------

export interface TotpEnrollment {
  factorId: string;
  /** Data URI SVG validado, ou `null` (a tela mostra só a chave manual). */
  qrCodeDataUri: string | null;
  secret: string;
}

/** Remove (best-effort) um fator NÃO verificado; nunca lança nem registra nada. */
export async function discardUnverifiedFactor(
  supabase: SupabaseClient,
  factorId: string,
): Promise<void> {
  try {
    await supabase.auth.mfa.unenroll({ factorId });
  } catch {
    /* fator pendente expira sozinho; a próxima tentativa o limpa */
  }
}

/**
 * Inicia o cadastro de um fator TOTP: primeiro descarta fatores TOTP não
 * verificados de tentativas anteriores (evita conflito/lixo), depois chama
 * `mfa.enroll`. Lança `Error` genérico em caso de falha.
 */
export async function startTotpEnrollment(supabase: SupabaseClient): Promise<TotpEnrollment> {
  try {
    const { data: listed } = await supabase.auth.mfa.listFactors();
    for (const factor of listed?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await discardUnverifiedFactor(supabase, factor.id);
      }
    }
  } catch {
    /* segue: o enroll abaixo decide o resultado */
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
  if (error || !data) throw new Error("enroll_failed");
  return {
    factorId: data.id,
    qrCodeDataUri: toSafeQrCodeDataUri(data.totp.qr_code),
    secret: data.totp.secret,
  };
}

// -----------------------------------------------------------------------------
// Reautenticação (step-up) com o fator TOTP já cadastrado.
// -----------------------------------------------------------------------------
// Ações sensíveis (ex.: resetar o MFA de outra pessoa) exigem que a sessão do
// ADM tenha verificado o TOTP há poucos minutos — o backend responde 403
// `REAUTH_REQUIRED` caso contrário. Este helper repete o MESMO desafio do
// login (`listFactors` → fator TOTP verificado → `challengeAndVerify`), que
// renova a sessão com o claim `amr` atualizado. O código digitado não é
// guardado em nenhum lugar. Quem decide se a reautenticação vale é o backend.

export type TotpReauthResult = "verified" | "invalid_code" | "no_factor" | "error";

export async function reverifyTotp(code: string): Promise<TotpReauthResult> {
  // Import dinâmico: mantém este módulo utilitário livre do SDK no SSR.
  const { getSupabaseClient } = await import("@/lib/supabase-client");
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return "error";
    // Só um fator JÁ VERIFICADO serve para reautenticar (UA-FE-03): verificar
    // um fator pendente concluiria um cadastro em vez de provar a identidade.
    const factor = data.all.find((f) => f.factor_type === "totp" && f.status === "verified");
    if (!factor) return "no_factor";
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: code.trim(),
    });
    return verifyError ? "invalid_code" : "verified";
  } catch {
    return "error";
  }
}
