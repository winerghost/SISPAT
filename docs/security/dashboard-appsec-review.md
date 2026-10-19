# Revisão AppSec — endpoints do dashboard

Escopo: `GET /api/v1/dashboard/{resumo,por-unidade,por-situacao,aquisicoes-mensais}`.
Testes: `backend/tests/test_sec_dashboard_review.py`.

| # | Achado | Severidade (CVSS 3.1) | Status |
|---|--------|-----------------------|--------|
| 1 | Escopo do dashboard (`unit_id`) divergia de `/assets` (`unit_id` OU `owner_unit_id`): subcontagem, sem vazamento. | LOW (3.1, `AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N`) | Corrigido: `asset_scope_clause` compartilhada |
| 2 | `GROUP BY description` sem teto: N descrições distintas viravam N linhas em memória. | LOW (4.3, `AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L`) | Corrigido: `ORDER BY count DESC LIMIT MAX_GRUPOS`, excedente somado em balde |
| 3 | Colisão: tipo real "OUTROS" somava ao balde "OUTROS". | LOW (3.1) | Corrigido: chave interna `__OUTROS__`; tipo real sai como `OUTROSTIPO` |
| 4 | Alias de unidade importado chegava cru em `unidade`. | INFO (0.0; defesa em profundidade, React escapa) | Corrigido: allowlist `clean_alias` |
| 5 | Movimentações pendentes contam trânsito para/de unidades fora do escopo. | INFO | Aceito e documentado |

## Decisão sobre o achado 5
`movimentacoes_pendentes` conta movimentações PENDENTE com origem OU destino no
escopo (mesma regra de `movement_service`). A resposta é só um inteiro, sem identificar
a unidade alheia; aceito por paridade com a listagem de movimentações do usuário.

## Notas
- Com o escopo canônico, `por-unidade` pode listar a unidade física de um bem cujo
  `owner_unit_id` está no escopo (mesma visibilidade que `/assets` já concede).
- Aprovados sem achado: IDOR por `unit_id`, allowlist de query (400 auditado), AAL2 de
  ADM, métodos de escrita, rótulos inertes, DoS em `infer_type`, logs sem token/PII,
  ausência de SQL bruto e de sinks perigosos no frontend.
