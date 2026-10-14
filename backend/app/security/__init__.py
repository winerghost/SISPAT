"""Utilitários transversais de segurança do SISPAT-AGU.

Contém, por ora, o decorator de limitação de tentativas (`rate_limit`),
baseado em Redis, pensado para ser reaproveitado em qualquer rota sensível
(ex.: convite de usuários, tentativas de login, operações de recuperação de
MFA) — não é específico de nenhum endpoint em particular.
"""
from app.security.rate_limit import rate_limit  # noqa: F401

__all__ = ["rate_limit"]
