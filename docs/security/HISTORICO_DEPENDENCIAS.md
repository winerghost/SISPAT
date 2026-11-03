# Histórico de dependências e correções de segurança

> **Alteração mais recente: 2026-11-02** — `pyasn1` 0.6.4 → 0.6.5 (4 CVEs de
> DoS por CPU). Ver a última seção deste arquivo; o quadro abaixo é o estado
> de 2026-10-29 e segue como registro daquela data.

> **Estado em 2026-10-29** (conferido só pelo que está no repositório; nenhum
> scanner foi reexecutado para escrever este documento).
>
> - Runtime do backend: `backend/requirements.txt` (versões fixadas com `==`) +
>   `backend/requirements.lock` (59 pacotes com hashes, alvo Linux/Python 3.12;
>   instalação com `--require-hashes`). Ferramentas de teste ficam em
>   `backend/requirements-dev.txt`, fora da imagem.
> - Frontend: `frontend/package.json` com versões exatas (sem ranges) e
>   `overrides` de `postcss`.
> - Imagens base fixadas por digest: `python:3.12-slim-trixie` (backend) e
>   `node:24-alpine` (frontend).
> - Último relatório de varredura presente na árvore:
>   `reports/security/20261029T155902Z/` (diretório `reports/` é **gitignored**;
>   existe só na máquina que rodou). Resultado registrado nele: `bandit` sem
>   achados MEDIUM/HIGH, `semgrep` sem WARNING/ERROR, `npm audit` de produção
>   sem vulnerabilidades, `compose` válido, `pip-audit` do lock **sem
>   vulnerabilidades** (`pip-audit-lock.json`, 0 em 59 pacotes), `gitleaks` e
>   `trivy` **NÃO EXECUTADOS** (binários ausentes). O `summary.txt` desse
>   diretório diz "pip-audit ACHADOS" por uma limitação conhecida do script
>   (não há `pip-audit-dev.json`: no Python 3.10 local o `requirements-dev.txt`
>   não é auditável porque `pillow==13.0.0` exige 3.11+), e não por
>   vulnerabilidade no lock.
> - **Não reexecutado nesta data:** `pip-audit`, `npm audit`, `gitleaks`,
>   `trivy` e qualquer build de imagem. Tudo acima é leitura de arquivos do
>   repositório.

## 2026-10-29 — estado das dependências apontadas em rodadas anteriores

| Item | Achado original | Estado no repositório |
|---|---|---|
| `certifi` | DEP-CERTIFI (Média, §17 de `SECURITY_AUDIT.md`): `certifi 2026.7.22` com PYSEC-2026-4320, afetando o TLS de saída para Google, Supabase e n8n | **Corrigido**: `backend/requirements.lock:29` traz `certifi==2026.10.19`, exatamente a versão pedida pelo achado. Requer rebuild da imagem do backend para valer em produção |
| `pillow` | DEP-PILLOW (Baixa, não alcançável): `pillow 12.3.0` com 8 CVEs de decodificadores | **Corrigido**: `backend/requirements.txt:41` e `requirements.lock:699` em `pillow==13.0.0`. Efeito colateral documentado: 13.x exige Python ≥ 3.11, então o `requirements-dev.txt` não pode ser auditado no Python 3.10 local (a imagem usa 3.12) |
| `next` | GHSA-2464-fhr4-w9xw (crítico) e GHSA-p3m5-59mp-jv5r | **Corrigido** em 2026-10-23 (entrada abaixo); `frontend/package.json` em `next` e `eslint-config-next` `15.5.28` |
| devDependencies do frontend | DSO-04 (Baixa, residual): avisos moderados em `postcss-selector-parser` via `tailwindcss` 3.x | **Aberto, só dev**: `npm-audit-all.json` de 2026-10-29 registra **1 moderado** (`postcss-selector-parser`, GHSA-rj75-hqrm-r3gf) e **0** high/critical; `npm-audit-prod.txt` do mesmo diretório: "found 0 vulnerabilities". A correção exige Tailwind 4 (mudança incompatível) |
| venv de 195 MB em `docs/security-audit/.venv` | DSO-18 (Info) | **Resolvido**: o diretório hoje tem só `achados.md`, `generate_report.py` e o PDF do relatório antigo; `docs/security-audit/` está no `.gitignore` (linha 52) |

## 2026-10-23 — Next.js 15.5.27 → 15.5.28

- Motivo: `npm audit --omit=dev` apontava 1 vulnerabilidade crítica em `next`
  (<= 15.5.27): GHSA-2464-fhr4-w9xw (RCE não autenticado no otimizador de
  imagens com SVG) e GHSA-p3m5-59mp-jv5r (DoS em Server Actions do App Router).
- Ação: `next` e `eslint-config-next` fixados em `15.5.28` (mesma linha 15.5,
  sem salto de major). Lockfile atualizado.
- Resultado: `npm audit --omit=dev` = 0 vulnerabilidades.
- Restante (apenas dev, não vai para a imagem de produção): 3 avisos moderados
  GHSA-rj75-hqrm-r3gf (`postcss-selector-parser` < 7.1.6 via `tailwindcss` 3.x).
  A correção exige Tailwind 4 (mudança incompatível); fica como pendência.
  (Em 2026-10-29 o `npm audit` arquivado aponta 1 aviso moderado desse mesmo
  pacote.)
- Implantação: requer rebuild da imagem do frontend
  (`cd /opt/SISPAT && docker compose build frontend && docker compose up -d frontend`).

## Como reconferir (sem alterar nada)

```bash
# varredura completa (gera reports/security/<timestamp>/)
scripts/security-audit.sh

# só dependências
scripts/check-dependencies.sh
```

`gitleaks` e `trivy` só rodam se os binários estiverem disponíveis
(`GITLEAKS_BIN`, `TRIVY_BIN`); `trivy image` também exige o daemon do Docker.
Enquanto faltarem, o script sai com status 1 em `--strict` e os dois constam
como **NÃO EXECUTADOS** — não como "sem achados".

## Implantação de qualquer atualização de dependência

Mudança em `backend/requirements*.txt`/`.lock` exige rebuild do backend; em
`frontend/package.json`/`package-lock.json`, do frontend:

```bash
cd /opt/SISPAT && docker compose build backend && docker compose up -d backend
cd /opt/SISPAT && docker compose build frontend && docker compose up -d frontend
```

## Higiene de artefatos de teste

`.gitignore` (raiz e `frontend/`) ignora `test-results-*/`, `playwright-report/`,
`.next-*/` e `/reports/`. **O `.gitignore` não desrastreia o que já foi
commitado** — confirmado por consulta git somente-leitura em 2026-10-30
(PREDEPLOY-03). Situação nessa data:

- `reports/`: **0** arquivos rastreados (ok).
- Ainda **rastreados**, apesar da regra de ignore: `.claude/agents/sispat-backend-domain.md`,
  `.claude/agents/sispat-backend-platform.md`, `.claude/agents/sispat-frontend.md`,
  `.claude/agents/sispat-security-reviewer.md`, `.claude/settings.local.json`,
  `docs/security-audit/generate_report.py` e
  `docs/security-audit/relatorio-auditoria-seguranca.pdf` (relatório de segurança antigo).
- `docs/security-audit/achados.md` **não** está rastreado: o documento de achados
  daquela auditoria está fora do versionamento.
- Diretórios `frontend/test-results-*` que já estivessem versionados têm o mesmo
  problema.

Ação pendente, **manual e do responsável** (nenhum agente executa git que altere
estado): `git rm -r --cached` nesses caminhos e commit.

## 2026-11-01 — `pyasn1` 0.6.4: 4 CVEs de DoS por CPU (CORRIGIDO em 2026-11-02)

> Registro histórico do dia do achado. A correção está na seção
> **2026-11-02 — `pyasn1` 0.6.4 → 0.6.5**, no fim deste arquivo.


Achado do `scripts/security-audit.sh --no-install` rodado em 2026-11-01
(relatório em `reports/security/20261101T171453Z/`, que é gitignored). **Não
tem relação com a entrega daquele dia** (reversão da logomarca, só frontend):
é dívida de dependência do backend, pré-existente e até aqui não registrada.

- Pacote: `pyasn1==0.6.4`, fixado em `backend/requirements.lock:874`. Entra como
  dependência transitiva (`pyasn1` ← `pyasn1-modules` ← `google-auth`), ou seja,
  pelo caminho da integração com o Google Sheets.
- CVEs: `CVE-2026-119194`, `CVE-2026-119195`, `CVE-2026-119196` e
  `CVE-2026-119197`. Todas da mesma classe: decodificação de ASN.1 (BER/CER/DER)
  com custo **quadrático** de CPU — tags longas em container sem schema,
  `BIT STRING`/`OCTET STRING` construídos com muitos fragmentos e `REAL` com
  mantissa grande. Impacto é disponibilidade (CPU do worker), sem perda de
  confidencialidade ou integridade.
- Correção publicada: **0.6.5**.
- Exposição neste projeto: o ASN.1 decodificado por esse caminho vem das
  respostas do Google na autenticação da API do Sheets, não de entrada de
  usuário final — o que reduz muito a exposição, mas **não a zera**: o
  `CLAUDE.md` trata o Google Sheets como entrada NÃO confiável. O restante do
  lock está limpo (`vulns: []` em todos os outros pacotes).
- Pendente de decisão do responsável: subir `pyasn1` para `0.6.5` no
  `requirements.txt`/`requirements.lock` (com recompilação do lock e rebuild do
  backend: `docker compose up -d --build backend`) ou registrar aceite do risco
  com justificativa. Nenhuma das duas coisas foi feita nesta data.
- Nessa mesma execução: `bandit`, `semgrep`, `npm audit` de produção e a
  conferência do compose vieram **OK**; `gitleaks` e `trivy` **não executados**
  (binários ausentes na máquina), não aprovados.

## 2026-11-02 — `pyasn1` 0.6.4 → 0.6.5 (corrige os 4 CVEs acima)

- Motivo: `scripts/security-audit.sh` saía com **exit 1** por causa do
  `pip-audit` do lock. Confirmado na fonte, não no resumo:
  `reports/security/20261102T042531Z/pip-audit-lock.json` (gitignored) traz
  `pyasn1 0.6.4` como **único** pacote com achado entre os 59 do lock — os
  outros 58 com `vulns: []` — e `fix_versions: ["0.6.5"]` nas quatro entradas:
  `CVE-2026-119194` (GHSA-fm9c-5rcf-2q5p), `CVE-2026-119195`
  (GHSA-9m75-vc3g-4x39), `CVE-2026-119196` (GHSA-2qm8-x737-gmw5) e
  `CVE-2026-119197` (GHSA-mm57-4v3p-rchx). O JSON do pip-audit não traz campo
  de severidade; os textos de duas delas declaram CVSS v3.1 **7,5** (base,
  só disponibilidade).
- Natureza: dependência **transitiva**, pela cadeia
  `google-auth` → `pyasn1-modules==0.4.2` → `pyasn1`, que existe por causa da
  leitura do Google Sheets.
- Compatibilidade conferida antes de pinar: `pyasn1-modules==0.4.2` declara
  `Requires-Dist: pyasn1<0.7.0,>=0.6.1` (metadados da própria release no
  PyPI). `0.6.5` cai dentro da faixa; **não** foi preciso mexer em
  `pyasn1-modules` nem em `google-auth`.
- Ação: pin explícito em `backend/requirements.txt` (bloco de integrações
  externas, ao lado de `google-auth`), no mesmo idioma já usado para
  `werkzeug` e `urllib3`:
  `pyasn1==0.6.5  # transitiva do google-auth (via pyasn1-modules); CVE-2026-119194/119195/119196/119197 corrigidos em 0.6.5`.
  Em `backend/requirements.lock`, só a estrofe do `pyasn1` mudou (versão,
  os dois hashes e o comentário `# via`, que agora também lista
  `-r requirements.txt`).
- Hashes (os mesmos que o `uv pip compile` gerou, conferidos contra os
  digests publicados no PyPI):
  wheel `sha256:4017b0fce125096b8573b39c989fdb1a4b19cf761e683398184550fea0e66587`,
  sdist `sha256:6b11616a6bcf3a40e635f082bb232fa57b5e0dd7f517bd7ddd69ec3794508a47`.
  Verificado que a instalação com hashes funciona:
  `pip download --no-deps --only-binary=:all: --require-hashes` baixou
  `pyasn1-0.6.5-py3-none-any.whl` (84.807 bytes) e o `sha256sum` do arquivo
  confere com o do lock. O wheel é `py3-none-any`, portanto serve ao alvo do
  lock (Linux x86_64 / Python 3.12).
- Resultado: `pip-audit --no-deps --disable-pip -r backend/requirements.lock`
  → **No known vulnerabilities found** (exit 0; 59 pacotes, 0 vulnerabilidades)
  em `reports/security/20261102T142531Z/pip-audit-lock.json`.

### Deriva do lock: por que a regeneração não ficou mínima

`scripts/check-dependencies.sh --lock` recompila o lock com
`uv pip compile --python-version 3.12 --python-platform x86_64-manylinux_2_28
--generate-hashes`, ou seja, resolve o alvo Linux/Python 3.12 **independente
da máquina** que roda o comando (aqui, Windows com Python 3.10). O problema é
que ele também reresolve toda transitiva **não** fixada para o que há de mais
novo no PyPI. A regeneração de 2026-11-02 trouxe, além do `pyasn1`, estas 12
mudanças **não pedidas**:

| Pacote | No lock | Recompilado |
|---|---|---|
| `amqp` | 5.4.1 | 5.4.2 |
| `billiard` | 4.3.1 | 4.3.2 |
| `certifi` | 2026.10.19 | 2026.10.23 |
| `google-api-core` | 2.42.0 | 2.43.2 |
| `googleapis-common-protos` | 1.75.5 | 1.76.0 |
| `httplib2` | 0.32.0 | 0.32.1 |
| `opentelemetry-api` | 1.45.1 | 1.45.2 |
| `pycparser` | 3.11 | 3.12 |
| `python-dateutil` | 2.9.0.post0 | **4.0.0** (salto de major) |
| `six` | 1.17.0 | **removido** (deixa de ser dependência de `python-dateutil`) |
| `tzdata` | 2026.5 | 2026.6 |
| `tzlocal` | 5.4.4 | 5.4.5 |
| `wcwidth` | 0.9.2 | 0.9.4 |

Essa deriva é **pré-existente e alheia ao `pyasn1`**: recompilando o
`requirements.txt` **sem** o pin novo (teste feito fora do repositório), o
resultado é exatamente a mesma lista — e `pyasn1==0.6.5` também aparece
sozinho, porque a faixa `<0.7.0` do `pyasn1-modules` já permite. Ou seja: o
lock do `HEAD` já estava defasado em relação ao PyPI antes desta tarefa, e a
etapa "3/5 Lockfile coerente com requirements.txt" do
`check-dependencies.sh` já falharia no `HEAD`.

Decisão tomada aqui: o lock foi mantido **mínimo** (só a estrofe do `pyasn1`),
para não elevar 12 pacotes — em especial `python-dateutil` 2.9 → 4.0, usado
pelo `celery` — sem decisão do responsável e sem teste nessas versões.
Consequências que o responsável precisa conhecer:

1. `scripts/check-dependencies.sh` acusa "requirements.lock desatualizado" na
   etapa 3/5 (comparação com uma recompilação do momento). Isso já valia para o
   `HEAD` e **não** é verificado por `scripts/security-audit.sh`.
2. Para zerar essa etapa havia duas saídas:
   (a) aceitar a regeneração completa e revalidar a suíte nessas versões; ou
   (b) fixar as transitivas acima em `requirements.txt` nas versões já testadas
   (congelamento), e então o lock volta a ser reprodutível pelo script.

#### Resolvido em 2026-11-02 — escolhida a saída (b)

O responsável autorizou o congelamento. `backend/requirements.txt` ganhou o
bloco "Transitivas congeladas nas versões testadas pela suíte" com **12 pins**
(`amqp`, `billiard`, `certifi`, `google-api-core`, `googleapis-common-protos`,
`httplib2`, `opentelemetry-api`, `pycparser`, `python-dateutil`, `tzdata`,
`tzlocal`, `wcwidth`). `six` **não** foi fixado: ele volta sozinho como
transitiva de `python-dateutil` 2.9.0.post0.

Resultado da regeneração seguinte (`scripts/check-dependencies.sh --lock`):

- **Nenhum pacote mudou de versão.** Comparação linha a linha das 59 estrofes
  `nome==versão` antes e depois: idênticas.
- O diff do lock contra o `HEAD` passou a conter **apenas** os dois hashes do
  `pyasn1` e os blocos de comentário `# via`, que agora listam também
  `-r requirements.txt` nos 12 pacotes fixados. Nenhuma linha de versão ou de
  hash fora do `pyasn1`.
- `scripts/check-dependencies.sh`, etapa 3/5: **"OK — requirements.lock
  atualizado"**. Era a etapa que já falhava no `HEAD`.
- O `exit 1` que resta no script vem da etapa 2/5 e **não é vulnerabilidade**:
  é o `pip-audit` de `requirements-dev.txt` com resolução, que não roda nesta
  máquina (`No matching distribution found for pillow==13.0.0`, que exige
  Python >= 3.11; o local é 3.10, a imagem é 3.12). O `pip-audit` do lock, na
  mesma execução, responde `No known vulnerabilities found`.

Elevar qualquer um dos 12 passa a ser mudança própria, com pytest revalidado —
em especial `python-dateutil` 4.0.0, que remove a dependência de `six`.
### Teste de regressão (2026-11-02)

- `bash scripts/test-backend.sh` (suíte completa; relatórios em
  `reports/backend-tests/20261102T143153Z/`, gitignored): **15.107 passed,
  1 failed, 65 skipped, 4 xfailed**, cobertura de `app/` = **97%**, 1:39:52,
  exit **1**.
- A única falha é `tests/test_sec_dashboard_review.py::`
  `test_infer_type_linear_em_entrada_gigante`, um teste de **tempo de parede**:
  `assert time.perf_counter() - start < 5` deu **5,06 s**. É o mesmo teste
  sensível a carga que já falhou em 2026-10-29 (6,3 s); não toca ASN.1 nem
  dependências. Essa execução levou 1:39:52 contra ~1:05 da medição anterior,
  com a máquina sob carga.
- Reexecutado em isolamento: `pytest -q tests/test_sec_dashboard_review.py`
  → **178 passed** em 66 s. Nenhuma regressão atribuível ao `pyasn1`.
- Ressalva importante: `scripts/test-backend.sh` sem `--venv` roda no Python
  **global** da máquina (3.10.0), cujas versões instaladas **não** são as do
  lock (ali há `flask 3.0.3`, `pillow 12.3.0`, `pytest 8.2.2` e `pyasn1 0.6.4`).
  A suíte prova que o **código** não regrediu, mas **não** exercita o
  `pyasn1 0.6.5` nem as demais versões do lock. Isso só acontece no build da
  imagem (Python 3.12 + `--require-hashes`), que é do responsável.

- Implantação: exige rebuild da imagem do backend
  (`cd /opt/SISPAT && docker compose build backend && docker compose up -d backend`).
  Nada foi construído, implantado nem aplicado em banco nesta tarefa.
