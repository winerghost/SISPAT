"""Pacote de serviços de domínio (camada entre a API e os modelos ORM) do SISPAT-AGU.

Um "serviço" encapsula regras de negócio que não pertencem nem à camada de
transporte HTTP (`app.api`), nem aos modelos ORM em si (`app.models`), nem a
um cliente de integração externa (`app.integrations`). Recebe suas
dependências (sessão de banco, clientes externos) por injeção no construtor,
para facilitar testes com mocks — ver `app.services.import_service`.
"""
from __future__ import annotations

__all__: list[str] = []
