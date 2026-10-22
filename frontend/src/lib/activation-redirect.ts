// =============================================================================
// SISPAT-AGU — activation-redirect.ts
// =============================================================================
// Rede de segurança para e-mails do Supabase que caem na raiz (Site URL):
// `/?token_hash=<hash>&type=invite|recovery` -> `/ativar-conta?token_hash=..&type=..`.
//
// Destino FIXO (nunca vindo da URL — sem open redirect). Só `token_hash` e
// `type`, validados por formato, são repassados; qualquer outro parâmetro é
// descartado e qualquer valor fora do formato resulta em `null` (sem redirecionar).
// A autoridade sobre o token continua sendo do Supabase (verifyOtp em /ativar-conta).
// =============================================================================

const ACTIVATION_ROUTE = "/ativar-conta";
const TOKEN_HASH_MAX_LENGTH = 512;
const TOKEN_HASH_FORMAT = /^[A-Za-z0-9._~+/=-]+$/;

export function activationRedirectFor(search: string): string | null {
  const params = new URLSearchParams(search);
  const type = params.get("type");
  const tokenHash = params.get("token_hash");
  if (type !== "invite" && type !== "recovery") return null;
  if (!tokenHash || tokenHash.length > TOKEN_HASH_MAX_LENGTH) return null;
  if (!TOKEN_HASH_FORMAT.test(tokenHash)) return null;
  return `${ACTIVATION_ROUTE}?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;
}
