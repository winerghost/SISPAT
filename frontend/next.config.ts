import type { NextConfig } from "next";

// -----------------------------------------------------------------------------
// SISPAT-AGU — next.config.ts
// -----------------------------------------------------------------------------
// output: "standalone" é obrigatório aqui porque frontend/Dockerfile copia
// .next/standalone no estágio de runtime (ver comentário no próprio
// Dockerfile). Não remover sem atualizar o Dockerfile correspondente.
//
// Segurança (auditoria 2026-10-13, ver docs/security/evidence/frontend-security.md):
//   - Cabeçalhos ESTÁTICOS de segurança são definidos aqui (headers()).
//   - A Content-Security-Policy é DINÂMICA (nonce por requisição) e é emitida
//     por src/middleware.ts — não duplicar CSP aqui.
//   - poweredByHeader: false remove "X-Powered-By: Next.js".
//   - productionBrowserSourceMaps: false (padrão, explicitado) evita publicar
//     o código-fonte original em /_next/static/**.map.
// -----------------------------------------------------------------------------

const securityHeaders = [
  // HSTS: só tem efeito sob HTTPS (Cloudflare/CloudPanel). 2 anos + subdomínios.
  // "preload" NÃO é incluído: exige decisão explícita do dono do domínio.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Redundante com CSP frame-ancestors 'none'; mantido para navegadores antigos.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
      "interest-cohort=(), browsing-topics=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  eslint: {
    // O lint também roda no build (ignoreDuringBuilds: false) — regras de
    // segurança de .eslintrc.json (react/no-danger, no-eval...) bloqueiam o build.
    ignoreDuringBuilds: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
