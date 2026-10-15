// Uso: node src/lib/__tests__/security-render.cjs "$(pwd)"   (a partir de frontend/)
/* eslint-disable no-script-url -- payloads XSS de teste intencionais */
// Renderiza componentes reais do SISPAT com payloads XSS (marcador SISPAT_XSS_MARK)
// via react-dom/server e verifica que nenhum payload vira HTML ativo.
const path = require("path");
const fs = require("fs");
const Module = require("module");
const FE = process.argv[2];
const ts = require(path.join(FE, "node_modules/typescript"));
const req = Module.createRequire(path.join(FE, "package.json"));
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/")) request = path.join(FE, "src", request.slice(2));
  try { return origResolve.call(this, request, parent, ...rest); }
  catch (e) { return origResolve.call(this, req.resolve(request), parent, ...rest); }
};
for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (m, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
    });
    m._compile(out.outputText, filename);
  };
}
// next/navigation stub (fora do App Router)
const navPath = req.resolve("next/navigation");
require.cache[navPath] = { id: navPath, filename: navPath, loaded: true, exports: {
  usePathname: () => "/administracao/usuarios", useRouter: () => ({ push() {}, replace() {} }) } };

const React = req("react");
const { renderToString } = req("react-dom/server");
const { QueryClient, QueryClientProvider } = req("@tanstack/react-query");

const P = [
  `<img src=x onerror=console.log('SISPAT_XSS_MARK')>`,
  `"><svg/onload=console.log('SISPAT_XSS_MARK')>`,
  `javascript:console.log('SISPAT_XSS_MARK')`,
  `</td><script>console.log('SISPAT_XSS_MARK')</script>`,
];
const dangerous = [/<img[^>]*onerror/i, /<svg[^>]*onload/i, /<script>console\.log\('SISPAT_XSS_MARK/i, /href="javascript:/i, /src="javascript:/i];
let fail = 0;
function check(name, html) {
  const hits = dangerous.filter((r) => r.test(html));
  const marks = (html.match(/SISPAT_XSS_MARK/g) || []).length;
  console.log(`${hits.length ? "FAIL" : "OK  "} ${name}: marcadores renderizados como texto=${marks}, sinks ativos=${hits.length}`);
  if (hits.length) { fail++; console.log(html.slice(0, 2000)); }
}

// 1) Tabela de prévia do Google Sheets
{
  const { PreviewItemsTable } = require(path.join(FE, "src/components/features/imports/preview-items-table.tsx"));
  const src = fs.readFileSync(path.join(FE, "src/components/features/imports/preview-items-table.tsx"), "utf8");
  const pageSize = Number((src.match(/PAGE_SIZE\s*=\s*(\d+)/) || [])[1]);
  const qc = new QueryClient();
  const items = P.map((p, i) => ({ id: `id${i}`, source_record_id: p, patrimony_number: p, description: p,
    classification: i % 2 ? "INVALIDO" : "NOVO", selected: false, validation_errors: [p] }));
  qc.setQueryData(["import-preview-items", "pv1", 1, pageSize, undefined, ""], { total: items.length, page: 1, page_size: pageSize, items });
  const html = renderToString(React.createElement(QueryClientProvider, { client: qc },
    React.createElement(PreviewItemsTable, { previewId: "pv1", onSelectionSummaryChange() {} })));
  check("PreviewItemsTable (Google Sheets)", html);
}
// 2) Lista de usuários (nome/e-mail/papéis vindos da API)
{
  const Page = require(path.join(FE, "src/app/(app)/administracao/usuarios/page.tsx")).default;
  const qc = new QueryClient();
  // Chave/forma atuais (gestão de usuários, Etapa 2): lista + unidades do filtro.
  qc.setQueryData(["users", "list", { sort: "name", page: 1, page_size: 25 }], { total: 4, page: 1, page_size: 25,
    users: P.map((p, i) => ({ id: `u${i}`, name: p, email: p, active: true, role: "USER", has_avatar: false,
      units: [{ id: `un${i}`, code: p, name: p }], created_at: "2026-01-01T00:00:00Z", last_login_at: null,
      deactivated_at: null, version: 1 })) });
  qc.setQueryData(["units"], { units: P.map((p, i) => ({ id: `un${i}`, code: p, name: p })) });
  const html = renderToString(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Page)));
  check("AdministracaoUsuariosPage", html);
}
// 3) Badge/TableCell genéricos + mensagem de erro de API
{
  const { Badge } = require(path.join(FE, "src/components/ui/badge.tsx"));
  const { ApiError } = require(path.join(FE, "src/lib/api-client.ts"));
  const err = new ApiError(P[0], 400, { error: { code: "x", message: P[0] } }, "x");
  const html = renderToString(React.createElement("div", null, P.map((p, i) => React.createElement(Badge, { key: i }, p)), React.createElement("p", null, err.message)));
  check("Badge + ApiError.message", html);
}
// 4) QR code TOTP: só data URI SVG aceito
{
  const { toSafeQrCodeDataUri } = require(path.join(FE, "src/lib/mfa.ts"));
  const cases = [["javascript:console.log('SISPAT_XSS_MARK')", null], ["https://evil.example/x.svg", null],
    ["data:text/html,<script>1</script>", null], ["data:image/svg+xml;utf-8,<svg/>", "data:image/svg+xml;utf-8,<svg/>"]];
  for (const [input, exp] of cases) { const got = toSafeQrCodeDataUri(input); if (got !== exp) { fail++; console.log("FAIL mfa", input, got); } }
  const raw = toSafeQrCodeDataUri("<svg><text>#a%</text></svg>");
  if (!raw.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg")) { fail++; console.log("FAIL mfa raw", raw); }
  console.log("OK   toSafeQrCodeDataUri (5 casos)");
}
// 5) CSP
{
  const { buildContentSecurityPolicy } = require(path.join(FE, "src/lib/csp.ts"));
  const csp = buildContentSecurityPolicy({ nonce: "abc", isDev: false, apiUrl: "/api", supabaseUrl: "https://x.supabase.co" });
  const must = ["default-src 'self'", "'nonce-abc'", "'strict-dynamic'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self' https://x.supabase.co"];
  const bad = ["unsafe-eval", "script-src 'self' 'unsafe-inline'", "ws:"];
  const ok = must.every((m) => csp.includes(m)) && !bad.some((b) => csp.includes(b));
  const csp2 = buildContentSecurityPolicy({ nonce: "n", isDev: false, apiUrl: "javascript:alert(1)", supabaseUrl: "not a url" });
  const ok2 = csp2.includes("connect-src 'self';");
  if (!ok || !ok2) { fail++; console.log("FAIL csp", csp, csp2); } else console.log("OK   buildContentSecurityPolicy (prod sem unsafe-eval/unsafe-inline em script; origens inválidas descartadas)");
}
// 6) AuthGuard: rotas públicas
{
  const { isPublicRoute } = require(path.join(FE, "src/lib/auth-guard.tsx"));
  const exp = { "/login": true, "/ativar-conta": true, "/": false, "/loginx": false, "/administracao/usuarios": false, "/register": false };
  for (const [p, e] of Object.entries(exp)) if (isPublicRoute(p) !== e) { fail++; console.log("FAIL isPublicRoute", p); }
  console.log("OK   isPublicRoute (6 casos)");
}
// 7) api-client: origem (F-1), Retry-After (F-10), mensagens (F-10), chave de /me (F-3), timeout (F-2)
const asyncTests = [];
{
  const { buildApiUrl, assertApiOrigin, parseRetryAfter, ApiError, apiClient } = require(path.join(FE, "src/lib/api-client.ts"));
  const { rateLimitMessage, formatRetryAfter, throttleOrForbiddenMessage } = require(path.join(FE, "src/lib/api-errors.ts"));
  const { meQueryKey } = require(path.join(FE, "src/lib/session.ts"));
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof ApiError; } };
  const t = (name, ok) => { if (!ok) { fail++; console.log("FAIL", name); } };
  const API = "https://api.exemplo.invalid/api";
  t("buildApiUrl absoluta", buildApiUrl("/v1/me", { a: 1 }, API) === "https://api.exemplo.invalid/api/v1/me?a=1");
  t("buildApiUrl relativa", buildApiUrl("/v1/me", undefined, "/api") === "/api/v1/me");
  t("buildApiUrl //host rejeitado (relativa)", throws(() => buildApiUrl("//evil.invalid/x", undefined, "")));
  t("buildApiUrl @host fica no path da API (barra inicial impede userinfo)", buildApiUrl("@evil.invalid/x", undefined, "https://api.exemplo.invalid") === "https://api.exemplo.invalid/@evil.invalid/x");
  t("assert mesma origem", !throws(() => assertApiOrigin(API + "/v1/me", API, "https://app.exemplo.invalid", true)));
  t("assert origem alheia", throws(() => assertApiOrigin("https://evil.invalid/api/v1/me", API, "https://app.exemplo.invalid", true)));
  t("assert relativa = origem da página", !throws(() => assertApiOrigin("/api/v1/me", "/api", "https://app.exemplo.invalid", true)));
  t("assert relativa rejeita host alheio", throws(() => assertApiOrigin("https://evil.invalid/x", "/api", "https://app.exemplo.invalid", true)));
  t("assert http em produção rejeitado", throws(() => assertApiOrigin("http://api.exemplo.invalid/api/v1/me", "http://api.exemplo.invalid/api", "http://app.exemplo.invalid", true)));
  t("assert http loopback em produção permitido", !throws(() => assertApiOrigin("http://127.0.0.1:5000/api/v1/me", "http://127.0.0.1:5000/api", "http://localhost:3100", true)));
  t("assert http em dev permitido", !throws(() => assertApiOrigin("http://api.exemplo.invalid/api/v1/me", "http://api.exemplo.invalid/api", "http://app.exemplo.invalid", false)));
  t("Retry-After inteiro", parseRetryAfter("90") === 90);
  t("Retry-After ausente/inválido", parseRetryAfter(null) === undefined && parseRetryAfter("abc") === undefined && parseRetryAfter("-5") === undefined);
  t("Retry-After data HTTP", parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")) === 30);
  t("Retry-After limitado a 24h", parseRetryAfter("999999999") === 86400);
  t("formatRetryAfter", formatRetryAfter(undefined) === "alguns instantes" && formatRetryAfter(1) === "1 segundo" && formatRetryAfter(90) === "2 minutos" && formatRetryAfter(3600) === "1 hora");
  t("429 com Retry-After", rateLimitMessage(new ApiError("SISPAT_BACKEND_MSG", 429, undefined, undefined, 30)).includes("30 segundos"));
  t("429 sem Retry-After", rateLimitMessage(new ApiError("SISPAT_BACKEND_MSG", 429)).includes("alguns minutos"));
  t("403/429 nunca exibem message do backend", [403, 429].every((c) => !throttleOrForbiddenMessage(new ApiError("SISPAT_BACKEND_MSG", c)).includes("SISPAT_BACKEND_MSG")));
  t("outros status => undefined", throttleOrForbiddenMessage(new ApiError("x", 500)) === undefined);
  t("meQueryKey sem token", JSON.stringify(meQueryKey("uid-1")) === '["me","uid-1"]' && JSON.stringify(meQueryKey(null)) === '["me",null]');
  const { classifySignInError, signInErrorMessage } = require(path.join(FE, "src/lib/auth-errors.ts"));
  t("signIn 400 invalid_credentials => credencial", classifySignInError({ status: 400, code: "invalid_credentials" }) === "credentials");
  t("signIn 429 => limite", classifySignInError({ status: 429 }) === "rate_limit" && classifySignInError({ code: "over_request_rate_limit" }) === "rate_limit");
  t("signIn rede (AuthRetryableFetchError/status 0/ausente/5xx) => rede",
    ["AuthRetryableFetchError"].every((n) => classifySignInError({ name: n, status: 0 }) === "network")
    && classifySignInError({ status: 0 }) === "network" && classifySignInError(new TypeError("Failed to fetch")) === "network" && classifySignInError({ status: 503 }) === "network");
  t("signIn 4xx desconhecido não enumera (credencial)", classifySignInError({ status: 422 }) === "credentials" && classifySignInError({ status: 403 }) === "credentials");
  t("signIn mensagens genéricas", signInErrorMessage({ status: 0 }) === "Não foi possível conectar. Tente novamente." && signInErrorMessage({ status: 400 }) === "E-mail ou senha incorretos.");
  console.log("OK   api-client/api-errors/session (origem, https, Retry-After, mensagens, chave /me)");

  // F-2: o timeout cobre a leitura do corpo (fetch devolve headers; text() pendura).
  const realFetch = global.fetch;
  global.fetch = (_url, init) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
  });
  asyncTests.push(
    apiClient.get("/v1/me", { auth: false, timeoutMs: 80 }).then(
      () => { fail++; console.log("FAIL timeout corpo: não rejeitou"); },
      (e) => {
        if (e instanceof ApiError && e.status === 0) console.log("OK   timeout cobre a leitura do corpo (F-2)");
        else { fail++; console.log("FAIL timeout corpo", e); }
      },
    ).finally(() => { global.fetch = realFetch; }),
  );
}
// F-notice: aviso de fator é best-effort (500 e rede ignorados), POST sem corpo para o caminho certo.
asyncTests.push((async () => {
  const { notifyMfaFactorAdded } = require(path.join(FE, "src/lib/users-api.ts"));
  const realFetch = global.fetch;
  const seen = [];
  try {
    global.fetch = (url, init) => { seen.push({ url: String(url), method: init.method, body: init.body }); return Promise.resolve(new Response('{"error":{"code":"X","message":"m"}}', { status: 500 })); };
    await notifyMfaFactorAdded();
    global.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    await notifyMfaFactorAdded();
    const ok = seen.length === 1 && seen[0].method === "POST" && seen[0].body === undefined && seen[0].url.endsWith("/v1/security/mfa/factor-added-notice");
    if (!ok) { fail++; console.log("FAIL notifyMfaFactorAdded", seen); } else console.log("OK   notifyMfaFactorAdded best-effort (500/rede ignorados, POST sem corpo)");
  } catch (e) { fail++; console.log("FAIL notifyMfaFactorAdded lançou", e); }
  finally { global.fetch = realFetch; }
})());
Promise.all(asyncTests).then(() => {
console.log(fail ? `\n${fail} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(fail ? 1 : 0);
});
