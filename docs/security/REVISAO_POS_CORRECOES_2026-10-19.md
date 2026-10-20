# Revisão pós-correções — 2026-10-19

Escopo: revisão SOMENTE LEITURA das correções feitas após `REVISAO_AUTHZ_2026-10-19.md`
e `REVISAO_INFRA_2026-10-19.md`. Nenhum código de produção alterado. Nenhum teste,
Playwright ou `security-audit.sh` executado (pedido do coordenador).

## Parecer: COM RESSALVAS

Nenhum achado Crítico/Alto. As correções de código (itens 1 e 2) estão corretas. Há
ressalvas operacionais (Médias/Baixas) em vhost, `.env.example` e roteiro, a tratar
antes do deploy. Isto NÃO é declaração de ausência de vulnerabilidades.

## Resultados por item

### 1. `get_json_body()` e `[]` — OK
- `backend/app/api/v1/schemas.py:327-339`: RecursionError -> `[]` (não nulo, não dict, `!= {}`).
- Consumidores, todos rejeitam `[]` com 400:
  - `parse_body` (schemas.py:348) rejeita não-dict: ai.py:114, ai_settings.py:88,
    catalog_http.py:84, email_settings.py:89 (via `_body_or_empty`), imports.py:220,
    me.py:114, users.py:240/569/604/635, e users.py:446 (`revoke`: `[]` não é None -> parse_body -> 400).
  - Rotas sem corpo: users.py:330, ai_settings.py:112 (`body is not None and body != {}` -> 400),
    user_admin_http.py:117-127 (`body == {}` só aceita `{}`; `[]` -> 400).
  - `authorization/rbac.py:365-369`: RecursionError -> `body=None` -> `raw_unit_id=None`
    -> `has_unit_access` nega (403 + evento). Falha fechada, correto.
- Grep em `backend/app`: não há `request.get_json`/`request.json` direto fora de schemas.py e rbac.py.
  `request.get_data(cache=True)` (catalog_http.py:91, email_settings.py:57, user_admin_http.py:117)
  só testa vazio, seguido de `get_json_body`. Nenhuma rota aceita `[]` como payload válido.
- Observação (Baixa, pré-existente): `get_json(silent=True)` devolve None para JSON malformado
  ou Content-Type errado; em users.py:444-447 (`revoke`) isso é tratado como "sem corpo"
  (motivo ignorado, sem erro). Não é bypass de autorização. Correção sugerida: usar a mesma
  checagem `get_data().strip()` das demais rotas e 400 se houver corpo e `body is None`.

### 2. `safe_scalar` — OK
- `services/admin_audit_service.py:124-128`: inteiro com 11 dígitos (abs) -> `[redacted]`;
  bool tratado antes (bool é subclasse de int). Strings CPF-like já cobertas (linha 130).
- Limitação (Info): inteiros de 11 dígitos legítimos (ex.: timestamps em ms têm 13, ok; IDs
  sequenciais pequenos, ok) são mascarados por falso positivo; aceitável. Float com 11
  dígitos (ex.: 12345678901.0) cai no `return None` final (descartado), seguro.

### 3. `infra/cloudpanel/vhost.conf.example`
OK: nenhum `add_header` (linhas 119-122 só comentário); nenhum `include`; blocos de proxy
literais em sensível (134), avatar (156), imports (183), `/api/` (207), `/` (235);
`X-Forwarded-For` sobrescrito (coerente com ProxyFix x_for=1, `__init__.py:171`);
zona `sispat_imports` usada em `^~ /api/v1/imports/` (precedência correta sobre regex;
métodos GET/POST coincidem com imports.py:90-204); regex de avatar coincide com
`me.py:131/152` e `users.py:772/796` (`avatar-url` cai em `/api/`, correto); rotas
sensíveis existem (`users.py:219/306`, `security.py` /mfa/...). Tabela de emissores coerente:
Flask `_SECURITY_HEADERS` + HSTS 31536000 se `request.is_secure` (`__init__.py:26-66`);
Next HSTS 63072000, Referrer-Policy `no-referrer` em `/ativar-conta`
(`next.config.ts:22,47-65`), CSP com nonce em middleware.ts:43-46. Sintaxe plausível;
`nginx -t` não foi executado.

Achados:
- **M-1 (Média, CVSS 3.1 ~5.3 AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L) — vhost.conf.example:94**
  `set_real_ip_from` está comentado. `nginx -t` passa sem ele, mas então `$remote_addr`
  é o IP da Cloudflare: `limit_req`/`limit_conn` (linhas 66-70, 114) viram um balde único para
  TODOS os usuários (10 r/m + burst 5 em convite/MFA: 429 generalizado), e a auditoria
  registra IP da Cloudflare. Correção: manter o passo OBRIGATÓRIO no checklist com verificação
  objetiva (o item "IP registrado é do cliente" já existe em checklist-deploy-vps.md:184;
  promovê-lo a bloqueante e testar 2 IPs distintos antes de liberar).
- **B-1 (Baixa) — linhas 134-173:** locations sensível e avatar não têm `limit_except`
  (só `/api/` e `/` têm); métodos como TRACE chegam ao Flask (que responde 405). Sugestão:
  `limit_except POST { deny all; }` na sensível e `PUT DELETE` no avatar.
- **B-2 (Baixa) — linha 244:** depende do `map $connection_upgrade` do CloudPanel; não
  verificado. `nginx -t` acusará se faltar (`unknown "connection_upgrade" variable`).
- **B-3 (Baixa) — linha 254:** `/` não oculta `Server` (só `X-Powered-By`; o Next já desliga
  `poweredByHeader`). Cosmético.
- **I-1 (Info):** `next.config.ts:58-65` — `/ativar-conta` e `/ativar-conta/:path*` podem
  casar ambos em `/ativar-conta`; o critério de aceitação por `curl | grep -ic` (vhost.conf.example:51-58)
  é o que confirma emissor único. Executar no deploy.

### 4. `.env.example`
Coerente com `settings.py:529-536` (https obrigatório em CORS e INVITE_* em produção) e com
comentários de SUPABASE_JWT_SECRET/REDIS_URL/GOOGLE_SHEETS_*_HOST_PATH comentados.
Segredos sem valor. Achados:
- **B-4 (Baixa) — .env.example:78 vs 52 e 243:** `FLASK_ENV=production` junto com
  `INVITE_ALLOWED_REDIRECT_URLS=http://localhost...` e `CORS_ALLOWED_ORIGINS=http://localhost...`:
  copiar sem editar derruba o backend no startup (falha fechada; comentário na linha 71-72
  avisa). Não é vulnerabilidade, mas dev local sem ajuste não sobe. Sugestão: documentar no
  topo, ou deixar `FLASK_ENV=development` e exigir `production` no ENV_PRODUCAO.
- **B-5 (Baixa) — linhas ativas com valor ilustrativo:** `DATABASE_URL=postgresql://usuario:senha@host...`
  (13) e `NEXT_PUBLIC_API_URL=http://localhost/api` (277). Nenhuma contém `<`, então o
  `grep -n '<' .env` não as detecta; `NEXT_PUBLIC_API_URL` esquecida vai embutida no bundle
  do build (http/localhost). Sugestão: comentar/zerar essas linhas e acrescentar ao roteiro
  `grep -nE '^(DATABASE_URL|NEXT_PUBLIC_API_URL|CORS_ALLOWED_ORIGINS|INVITE_ALLOWED_REDIRECT_URLS)=.*(localhost|usuario:senha)' .env` -> vazio.

### 5. Roteiro e checklist
Ordem coerente (pré-requisitos -> código/.env -> build -> stamp -> subir -> vhost -> verificação
-> rollback; stamp só com backup/PITR e autorização). Nenhum segredo exposto; comandos de
log filtram `token_hash|Bearer|eyJ|service_role`. Achados:
- **M-2 (Média, operacional) — ROTEIRO_VPS_ueato.md:58 e checklist-deploy-vps.md:92:**
  `grep -n '<' .env` "deve voltar VAZIA", mas `.env.example` tem `<` em comentários
  (linhas 15, 29, 41, 117, 118 etc.). Copiando o exemplo, o comando nunca volta vazio e o
  operador passa a ignorá-lo (alarme falso que mascara placeholder real). Correção:
  `grep -nE '^[^#]*<' .env`.
- **B-6 (Baixa) — ROTEIRO:29 vs checklist:44:** roteiro manda `security-audit.sh` sem
  `--strict`; checklist exige `--strict`. Alinhar.
- **B-7 (Baixa) — ROTEIRO:109:** o caminho `/etc/nginx/sites-enabled/<dominio>.conf`
  e a edição manual: o CloudPanel regenera o vhost a partir do editor; fazer a alteração pelo
  editor e guardar o backup do texto (já citado como alternativa). Não verificado na VPS.
- **B-8 (Baixa) — ROTEIRO:130 (Supabase único, dev = prod):** manter a Redirect URL
  localhost enquanto o dev precisar permite convite apontar a localhost; risco aceito e já
  registrado no roteiro (linha 33-34). Prazo para remoção não definido.

## Resumo por severidade
| Sev | IDs |
|---|---|
| Crítica/Alta | nenhum |
| Média | M-1 (real_ip comentado), M-2 (grep de placeholders ineficaz) |
| Baixa | B-1..B-8 e observação revoke (item 1) |
| Info | I-1, limite de safe_scalar |

## NÃO verificado
- Execução de pytest (incl. `test_sec_json_depth.py`, apenas localizado), Playwright,
  `security-audit.sh`, gitleaks, trivy, `nginx -t`, `docker compose config`.
- Comportamento real de cabeçalhos em runtime (contagem única de HSTS/Referrer-Policy),
  `map $connection_upgrade` no CloudPanel, firewall, Cloudflare, Supabase, backups/PITR.
- Conteúdo de `ENV_PRODUCAO_ueato.md`, `PRONTIDAO_2026-10-19.md`, middleware `matcher`
  completo, e rotas fora dos arquivos citados (imports/ai/me foram checadas apenas
  nos pontos de leitura de corpo).
- Que o esquema do banco corresponda às migrações 0007-0010 (pré-condição do stamp).
