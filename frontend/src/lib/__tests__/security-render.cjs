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
  qc.setQueryData(["users", 1], { total: 4, page: 1, page_size: 20,
    users: P.map((p, i) => ({ id: `u${i}`, name: p, email: p, active: true, roles: [p] })) });
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
console.log(fail ? `\n${fail} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(fail ? 1 : 0);
