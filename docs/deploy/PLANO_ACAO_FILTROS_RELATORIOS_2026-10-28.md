# Plano de ação — SALA, RESPONSÁVEL e VÍNCULO sem select em /relatorios

Data: 2026-10-28. Relato: em `/relatorios`, os campos **Sala**, **Responsável**
e **Vínculo** são de texto livre; deveriam ter select para facilitar a escolha.

## 1. Causa (verificada no código e no banco, não suposta)

Os campos de filtro são **gerados** a partir do catálogo do backend. Quem
escolhe o controle é `filter.type`, em
`frontend/src/components/features/reports/report-filters.tsx`:

| `type` | Controle |
|---|---|
| `unit` | `<select>` com lista de `units/accessible` |
| `inventory` | `<select>` com lista de inventários |
| `enum` | `<select>` com `options[]` fixas |
| `date` | `<input type="date">` |
| **qualquer outro (`text`, `uuid`)** | **`<input type="text">` livre** |

E o catálogo (`backend/app/services/report_catalog.py:67-70`) declara:

```python
{"name": "room_id", "type": "uuid"},
{"name": "responsible_person_id", "type": "uuid"},
{"name": "bond_status", "type": "text", "max_length": 64},
```

Logo, a pessoa tem de **digitar um UUID** para filtrar por sala ou responsável.
Não é defeito de interface: o frontend obedece ao tipo declarado. A correção
começa no backend.

## 2. Dimensionamento real (consultado no banco em 2026-10-28)

- **Salas:** 42, todas ativas.
- **Responsáveis:** 84, todos ativos.
- **Vínculo:** 4 valores distintos — `Servidor` (683 bens), `Terceirizado`
  (65), `Ocioso` (32), `Estagiario` (11) — e **278 bens com `bond_status`
  NULL**.

Conclusão de produto: `<select>` NATIVO basta nos três casos. Não justifica
combobox com busca, nem dependência nova. Mantém o padrão já usado por
`unit`/`inventory` e a acessibilidade que ele já tem.

## 3. O que já existe e deve ser reusado

- `GET /api/v1/rooms` e `GET /api/v1/responsible-people` (blueprints
  registrados em `app/api/v1/__init__.py:49-50`), com os mesmos padrões de
  escopo dos outros cadastros de apoio.
- `frontend/src/lib/catalog-api.ts` já fala com ambos (`ROOMS`, `PEOPLE`).
- `asset_service.BOND_STATUS_NONE = "__none__"` → o serviço traduz para
  `bond_status IS NULL`. É assim que "Sem vínculo" deve ser oferecido, sem
  inventar sentinela nova.
- O padrão de `LookupSource` (`options`/`loading`/`failed`) e o `<option>`
  "Selecionado anteriormente" para valor fora da lista.

## 4. Frente A — backend (catálogo e fonte das opções)

1. Dois tipos de lookup novos no catálogo: `room` para `room_id` e `person`
   para `responsible_person_id`. O contrato do catálogo passa a anunciá-los
   para o frontend, do mesmo jeito que `unit`/`inventory`.
2. `bond_status` deixa de ser `text` livre. As opções **não** podem ser
   codificadas na mão: o valor vem da planilha do Google Sheets (entrada não
   confiável que muda), então um `enum` fixo envelhece em silêncio no próximo
   import. A fonte tem de ser os valores DISTINTOS existentes, **já filtrados
   pelo escopo de unidade do ator**, mais a opção "Sem vínculo" mapeada para
   `__none__`.
3. Escopo e privacidade são o ponto crítico desta frente: a lista de salas e
   sobretudo a de **responsáveis** (dado pessoal, LGPD) não pode devolver
   registros de unidades fora do escopo do ator — senão o próprio `<select>`
   vira canal de enumeração. Vale a mesma regra do resto do sistema: negar por
   padrão, escopo por unidade no backend, RH sem dado pessoal fora da
   finalidade patrimonial.
4. A validação continua no backend (`extra="forbid"`, limites): o select é
   conveniência, nunca mecanismo de segurança. Um `room_id` de outra unidade
   tem de ser rejeitado mesmo que alguém o envie à mão.

## 5. Frente B — frontend (controles)

1. `report-filters.tsx`: tratar `room` e `person` como lookup, reusando o ramo
   de `unit`/`inventory` em vez de duplicá-lo — os quatro têm a mesma forma
   (lista carregada, "Todas as…", estado de carregando, aviso de lista
   indisponível, `<option>` para valor desconhecido).
2. `bond_status` passa a ser select pelo `enum`/opções que o catálogo mandar,
   com "Sem vínculo" → `__none__`.
3. Rótulos: "Todas as salas", "Todos os responsáveis", "Todos os vínculos".
   Ordenação alfabética estável.
4. Falha ao carregar uma lista **não** pode travar o relatório: mesmo
   comportamento degradado que `unit`/`inventory` já têm (aviso no `hint`,
   campo desabilitado, resto da tela funcionando).
5. DESIGN.md é a fonte do visual e não se altera. 320px–1920px sem rolagem
   horizontal, WCAG 2.2 AA, `prefers-reduced-motion`. Nenhuma dependência
   nova. 84 opções num `<select>` nativo são aceitáveis; não introduzir
   biblioteca de combobox.

## 6. Frente C — QA e segurança (depois de A e B)

- IDOR nas listas: sala/responsável de unidade alheia não aparece e, enviado à
  mão, é rejeitado com a mesma resposta de inexistente.
- Perfis: RH e USER não ganham acesso a dado pessoal fora da finalidade.
- Exportação CSV/XLSX continua passando por `app.security.csv_safety`.
- Playwright + axe nos três selects em 320/768/1920; lista indisponível;
  valor previamente selecionado fora da lista.
- `scripts/security-audit.sh` antes de implantar.

## 7. Implantação

Backend e frontend — as duas pontas mudam:
`cd /opt/SISPAT && docker compose build backend frontend && docker compose up -d backend frontend`.
Sem migração: nenhuma coluna nova. git é manual.

## 8. Falha INTERMITENTE catalogada (nao resolvida)

Em 2026-10-28, na 1a execucao da suite completa apos esta frente:

```
FAILED tests/test_reports_api.py::test_parametros_nao_declarados_400_e_auditados[limit=999999]
AssertionError: assert 500 == 400   (export de `assets` com ?limit=999999)
```

NAO reproduz: passa isolado (14/14), com o arquivo inteiro (66/66), junto do
`test_report_filter_lookups.py` novo (85/85) e na 2a execucao COMPLETA da
suite, com a mesma ordem de coleta (14842 testes, 0 falhas, 27:57 vs 26:02).
Logo e intermitente, nao regressao desta frente.

Por que fica catalogado em vez de ignorado: 500 onde se espera 400 e excecao
nao tratada numa rota de exportacao, e justamente a que REJEITA parametro nao
declarado (a defesa contra ampliar `limit`, pedir coluna interna via
`select=notes` ou injetar `where=1=1`). A defesa em si funcionou — nada foi
devolvido —, so o modo de falhar esta errado. Suspeita a investigar: recurso
compartilhado entre arquivos de teste (executor/threads ou cliente Redis do
rate limit), nao o codigo do catalogo.

Como atacar quando houver tempo: rodar a suite com `-p no:randomly` se o plugin
estiver ativo, e com `--timeout`/`-x` repetidamente so da faixa de arquivos
anterior a `test_reports_api.py`, procurando o vizinho que vaza estado. Nao
relaxar a assercao para 500.
