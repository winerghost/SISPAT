# Revisão AppSec pré-deploy — 2026-10-19

Escopo: alterações pendentes no working tree, `scripts/security-audit.sh`, checklist do CLAUDE.md,
abertos SEC-REV-01..03. Não revisado (por pedido): `frontend/src/app/(publico)/ativar-conta/page.tsx`
(em reescrita). Nenhum código de produção foi alterado; nenhum valor de `.env`/`secrets/` foi lido.
Este parecer não declara o sistema livre de vulnerabilidades.

## Parecer: BLOQUEADO condicionalmente

Bloqueio apenas pelos itens B1 e B2 abaixo (configuração/pendência de correção). Nenhum achado novo
de código nas alterações pendentes.

## O que rodou (resultado real)

| Ferramenta | Resultado |
|---|---|
| bandit -r backend/app | OK, sem MEDIUM/HIGH |
| pip-audit (lock + dev) | OK, sem vulnerabilidades conhecidas |
| npm audit (prod) | OK, sem high/critical |
| semgrep | 1 WARNING (templates.py:75), triado abaixo |
| docker compose config + check de portas | OK; portas só 127.0.0.1, sem 80/443, sem n8n |
| gitleaks | NÃO EXECUTADO (binário ausente) |
| trivy (imagem) | NÃO EXECUTADO (binário ausente; imagem exige daemon Docker) |
| pytest backend completo | ver "Suíte" no final |
| Playwright/axe, `--strict` | NÃO executados |

Relatórios brutos: `reports/security/20261019T184912Z/` (pasta gitignored).
Sem gitleaks, a ausência de segredos versionados NÃO foi comprovada por varredura; só se confirmou que
`.env`, `.env.*`, `secrets/`, `reports/`, `*.key`, `*.pem`, `.claude` estão no `.gitignore`.

## Alterações pendentes

| Arquivo | O que faz | Risco |
|---|---|---|
| `backend/app/services/invite_service.py` (~l.297) | exige que o 1º item de `INVITE_ALLOWED_REDIRECT_URLS` tenha path `/ativar-conta`, senão falha antes de chamar o Supabase | Reduz risco (fail-closed). Ver M2 (valida só o path, não o esquema) |
| `backend/app/errors.py` | handlers para SQLAlchemyError (503/504) e TimeoutError (504) | Sem vazamento: mensagem genérica, sem SQL/driver; Retry-After fixo. Aceitável |
| `backend/app/services/import_service.py` | pré-carga em lote de assets (N+1), log de tempos | Só leitura, consulta parametrizada (IN via ORM), cache limpo em `finally`. Log traz contagens/tempos, sem dados. Aceitável. Duplicação cosmética de `_asset_cache` (classe e instância) |
| `backend/Dockerfile` | gunicorn `--timeout 180`, graceful 30, keep-alive 5 | Aumenta janela de slowloris por worker (3 workers); mitigar no Cloudflare/CloudPanel (read timeout, rate limit). Aceitável |
| `.env.example` | novo default `INVITE_ALLOWED_REDIRECT_URLS=http://localhost:3000/ativar-conta`; comentários de timeout | Ver M2 |
| `frontend/src/lib/admin-access-api.ts`, `components/features/admin-access/*`, `perfis-permissoes/page.tsx` | tela SOMENTE LEITURA de perfis/permissões | Sem dangerouslySetInnerHTML/eval/storage; só `apiClient.get`; 401/403 vira texto fixo. Backend: `/admin/roles`, `/admin/permissions`, `/admin/unit-access` com `require_auth -> require_role("ADM") -> require_aal2 -> require_permission -> rate_limit` (`backend/app/api/v1/admin_access.py`), query vazia validada (`NoQuery`), sem e-mail/telefone. Aceitável |
| docs, testes e2e, `docs/deploy/*` | documentação/testes | Sem risco de execução |

## Achados

### BLOQUEIA deploy

B1. SEC-REV-01 (CVSS 4.3, Média) e SEC-REV-03 (CVSS 4.3, Média) ainda abertos. O próprio relatório de
17/10 os classifica como "corrigir antes do deploy". `backend/tests/test_sec_catalog_api_review.py`
l.38, 54 (REV-01), l.84 (REV-02), l.102 (REV-03), l.366 (REV-04) seguem `xfail(strict=True)`.
- REV-01: `get_json(silent=True)` não captura `RecursionError` -> 500 com traceback.
  Correção: capturar `RecursionError` no helper de parse de JSON (retornar 400) e/ou limitar
  profundidade/tamanho antes do parse.
- REV-03: `GET /assets/<id>/history` devolve `reason` (texto livre) ao RH. Correção: omitir/mascarar
  `reason` para perfil RH na serialização do histórico.
- Se o dono aceitar formalmente o risco (impacto baixo: A:L e C:L), registrar a decisão; caso
  contrário, corrigir. Estado de REV-02 (Baixa, 2.7) e REV-04 (defesa em profundidade): abertos.

B2. Verificação de segredos incompleta: gitleaks e trivy não rodaram. Instalar e rodar
`scripts/security-audit.sh --strict` antes de implantar (o script já aceita `GITLEAKS_BIN`/`TRIVY_BIN`).

### Corrigir logo

M1. Configuração de produção do convite sem trava de HTTPS. Nenhum código em
`backend/app/services/invite_service.py` ou `backend/app/config/settings.py` valida o esquema de
`INVITE_ALLOWED_REDIRECT_URLS` (a descrição em settings.py:217 diz "HTTPS obrigatório em produção",
mas não encontrei verificação). O novo default do `.env.example` é `http://localhost:3000/ativar-conta`;
se copiado para produção, o `token_hash` do convite trafegaria em URL http.
Correção: no startup (`FLASK_ENV=production`) falhar se qualquer item não for `https://`; teste de regressão.

M2. A checagem nova valida apenas `urlsplit(...).path`. Aceita `javascript:`-like não relevante (Supabase
valida allow-list), mas também não exige host da allow-list nem HTTPS (ver M1). Correção: usar a mesma
validação de esquema/host do M1 sobre o 1º item.

M3. Fluxo do convite (apenas desenho, `docs/deploy/email-template-convite.md`): o desenho (template com
`{{ .RedirectTo }}?token_hash=...&type=invite`, `verifyOtp` só após clique) é adequado contra consumo por
scanners de e-mail. Pontos: (a) o link contém `token_hash` na query; garantir `Referrer-Policy:
no-referrer`/`strict-origin` na página e remover o parâmetro da URL (`history.replaceState`) após ler;
(b) a página não deve logar a URL nem enviá-la a analytics; (c) o doc admite que
`{{ .RedirectTo }}` pode vir vazio — validar em teste real antes do deploy. Alterar o template no
Supabase exige autorização do dono do projeto.

### Aceitável / informativo

A1. semgrep `python.jinja2.security.audit.autoescape-disabled-false` em
`backend/app/services/email/templates.py:75` (o relatório anterior citava `app/email/templates.py`;
o caminho correto é `app/services/email/`). Reavaliado: FALSO POSITIVO. `_text_env` renderiza apenas o
corpo text/plain (l.133); o HTML usa `_html_env` com `autoescape=True` (l.74); nomes passam por
`clean_text` (remove controles, limita tamanho); templates são constantes no código. O `# nosec B701`
cobre o bandit, mas não o semgrep. Sugestão: adicionar `# nosemgrep: python.jinja2.security.audit.autoescape-disabled-false.incorrect-autoescape-disabled`
com justificativa, para o modo `--strict` não falhar. Verificar ainda que `action_url` é sempre gerada
pelo backend (nunca vinda do cliente).

A2. Checklist CLAUDE.md (verificação por leitura/execução do script):
- Segredos fora do git: `.gitignore` cobre `.env`, `.env.*`, `secrets/`, `*.pem`, `*.key`,
  `google_sheets_credentials*.json`, `.claude`, `reports/`. Observação: `CLAUDE.md`, `DESIGN.md` e
  `docs/security/SECURITY_AUDIT.md` também são ignorados (decisão deliberada do projeto). Este relatório
  novo NÃO é ignorado e é versionável; não contém segredos.
- CSP com nonce no frontend: `frontend/src/middleware.ts` (nonce por requisição). API: CSP
  `default-src 'none'; frame-ancestors 'none'` + `Cache-Control: no-store` + HSTS (`backend/app/__init__.py`).
- Sem `dangerouslySetInnerHTML`/`eval` em `frontend/src` (só ocorrências em comentários). Sem
  `localStorage`; sessão Supabase em `sessionStorage` (`supabase-client.ts`) — token em storage de aba é
  exposto a XSS, mitigado por CSP/nonce; risco residual aceito pelo projeto.
- `require_aal2` presente nas rotas admin lidas (admin_access.py). A cobertura total das rotas é
  verificada por `backend/tests/test_sec_route_inventory.py` (ver suíte).
- Compose: portas em `127.0.0.1`, `read_only`, runtime target `runtime` (prod), imagem com
  `USER 10001:10001`, `FLASK_ENV=production`; `FLASK_DEBUG=0` e `--no-debugger` até no override dev;
  gunicorn no CMD de produção.
- Frontend Dockerfile só recebe `NEXT_PUBLIC_*`; Service Role/N8N/SECRET_KEY ficam só no backend.
- CORS por allowlist (`CORS_ALLOWED_ORIGINS`); em produção definir somente o domínio final (o default
  de settings é `http://localhost:3000`).
- Não verificados nesta passada (sem execução dinâmica): cookies, rate limit sob carga, exportações
  csv_safety e IDOR/mass assignment em todas as rotas — dependem da suíte de testes `test_sec_*`.

## Suíte pytest (resultado real, INCONCLUSIVO)

A execução completa (`pytest -q -x`, timeout 900 s) e a execução direcionada (route_inventory,
catalog_api_review, invite_service, admin_read_api; timeout 540 s) foram interrompidas por tempo
em ~68% e ~72% respectivamente, sem resumo final. Até o ponto alcançado só havia pontos (sem F/E),
mas NÃO há contagem final de passed/xfailed; a suíte precisa ser reexecutada fora de limite de tempo
(por exemplo em segundo plano, com `-p no:cacheprovider -q` e saída para arquivo) antes de aprovar.

## Antes do deploy (checklist)
1. Corrigir ou aceitar formalmente SEC-REV-01/03 (e decidir 02/04).
2. Trava de HTTPS para `INVITE_ALLOWED_REDIRECT_URLS`, `CORS_ALLOWED_ORIGINS`, `SUPABASE_URL` em produção.
3. Rodar `bash scripts/security-audit.sh --strict` com gitleaks e trivy instalados.
4. Adicionar `nosemgrep` justificado em templates.py:75.
5. Cloudflare: read/header timeout e rate limit (gunicorn agora com timeout 180 s).
6. Conferir variáveis de produção (`.env` fora do git, `SECRET_KEY` forte, `SUPABASE_JWT_ISSUER`
   preenchido) sem commitar valores.

## Correções aplicadas (ciclo pré-deploy)

- SEC-REV-01: `read_body` (`api/v1/catalog_http.py`) captura `RecursionError` => 400 genérico.
- SEC-REV-02: `reject_unexpected_fields` neutraliza CR/LF/controles nos nomes antes de log/mensagem.
- SEC-REV-03: histórico do bem omite `reason` para RH (`AssetService._without_reason`).
- SEC-REV-04: `safe_scalar` redige strings com formato de CPF.
- M1/M2: com `FLASK_ENV=production`, `CORS_ALLOWED_ORIGINS` e `INVITE_ALLOWED_REDIRECT_URLS`
  só aceitam `https://` (falha no startup; checagem extra em `InviteService`). Fora de produção
  `http://localhost` continua permitido. Testes: `tests/test_sec_https_production.py`.
- `# nosemgrep` justificado em `services/email/templates.py`; `.env.example` ganhou
  `DB_POOL_RECYCLE_SECONDS` e `DB_POOL_TIMEOUT_SECONDS`.
