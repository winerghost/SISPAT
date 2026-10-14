// =============================================================================
// SISPAT-AGU — csp.ts
// =============================================================================
// Monta a Content-Security-Policy emitida por `src/middleware.ts` (nonce por
// requisição). Função pura (sem dependência de Next) para ser testável.
//
// Decisões:
//   - script-src: 'self' + nonce + 'strict-dynamic'. NENHUM 'unsafe-inline'
//     para scripts em produção. O Next 15 aplica o nonce automaticamente aos
//     seus <script> quando encontra o cabeçalho CSP na REQUISIÇÃO (por isso o
//     middleware o repassa) — e isso exige renderização dinâmica (ver
//     `export const dynamic = "force-dynamic"` em app/layout.tsx).
//   - 'unsafe-eval' SOMENTE em desenvolvimento (React Refresh/webpack dev).
//   - style-src 'unsafe-inline': justificado — o React aplica `style={...}`
//     como atributo inline e o `sonner` injeta um <style> em runtime. Injeção
//     de CSS não executa script; o risco residual (exfiltração via CSS) é
//     baixo e é mitigado por img-src/connect-src/font-src restritos.
//   - connect-src: só a própria origem, a origem da API (NEXT_PUBLIC_API_URL,
//     se absoluta) e a origem do Supabase Auth (NEXT_PUBLIC_SUPABASE_URL).
//   - frame-ancestors 'none', object-src 'none', base-uri 'self',
//     form-action 'self'.
// =============================================================================

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  apiUrl?: string;
  supabaseUrl?: string;
}

/** Extrai a origem (`scheme://host[:port]`) de uma URL absoluta http(s); senão `null`. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    // URL relativa (ex.: "/api") — coberta por 'self'.
    return null;
  }
}

export function buildContentSecurityPolicy({
  nonce,
  isDev,
  apiUrl,
  supabaseUrl,
}: CspOptions): string {
  const connectSrc = new Set<string>(["'self'"]);
  const apiOrigin = originOf(apiUrl);
  const supabaseOrigin = originOf(supabaseUrl);
  if (apiOrigin) connectSrc.add(apiOrigin);
  if (supabaseOrigin) connectSrc.add(supabaseOrigin);
  if (isDev) {
    // HMR do `next dev` usa WebSocket na mesma origem.
    connectSrc.add("ws:");
  }

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'"],
    // data: é necessário para o QR code TOTP (SVG em data URI, renderizado via
    // <img>, onde SVG não executa script).
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": [...connectSrc],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
