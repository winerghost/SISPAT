"""Pacote de autenticação do SISPAT-AGU.

Autenticação de usuários é delegada ao Supabase Auth (externo); este
pacote apenas VERIFICA os JWTs emitidos por ele e carrega o usuário
correspondente da tabela `users`. Nenhuma senha é processada ou
armazenada por este backend.
"""
from app.auth.supabase_auth import require_auth  # noqa: F401

__all__ = ["require_auth"]
