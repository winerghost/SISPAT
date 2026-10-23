# Histórico de dependências e correções de segurança

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
- Implantação: requer rebuild da imagem do frontend
  (`cd /opt/SISPAT && docker compose build frontend && docker compose up -d frontend`).

## Higiene de artefatos de teste

`.gitignore` (raiz e `frontend/`) ignora `test-results-*/`, `playwright-report/`
e `.next-*/`. Diretórios `frontend/test-results-*` que já estavam versionados
precisam de `git rm -r --cached` manual.
