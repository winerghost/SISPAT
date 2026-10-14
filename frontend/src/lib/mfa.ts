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
