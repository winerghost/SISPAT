// =============================================================================
// SISPAT-AGU — middleware.ts
// =============================================================================
// Emite a Content-Security-Policy com nonce por requisição (ver `@/lib/csp`).
//
// O nonce é repassado ao Next em dois cabeçalhos da REQUISIÇÃO:
//   - `x-nonce` (para uso explícito por Server Components, se necessário);
//   - `Content-Security-Policy` (o Next 15 lê este cabeçalho e aplica o nonce
//     automaticamente aos <script> que ele mesmo gera).
//
// Proteção de rotas: a sessão do Supabase Auth vive no storage do navegador
// (supabase-js), não em cookie — portanto o middleware NÃO consegue saber se
// há sessão. O redirecionamento de rotas protegidas é feito no cliente por
// `AuthGuard` (`@/lib/auth-guard`), que é apenas UX: a autorização real é
// SEMPRE do backend Flask (CLAUDE.md > Arquitetura). Ver o risco residual e o
// plano de migração para `@supabase/ssr` (cookies) em
// docs/security/evidence/frontend-security.md.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/csp";

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Tudo, exceto assets estáticos versionados e prefetches do router
      // (prefetch não precisa de CSP própria e não deve gastar nonce).
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
