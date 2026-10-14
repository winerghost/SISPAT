"""Pacote de integrações com sistemas externos ao SISPAT-AGU.

Contém clientes para serviços de terceiros (ex.: a instância n8n externa,
hospedada na VPS do usuário, fora deste projeto). Todo cliente deste pacote
deve seguir a mesma filosofia: falhas da integração externa NUNCA podem
derrubar uma operação patrimonial do backend — erros são capturados, logados
e retornados como resultado "falhou" ao chamador, a menos que o chamador
peça explicitamente para propagar a exceção.
"""
from app.integrations.google_sheets_client import (  # noqa: F401
    GoogleSheetsClient,
    GoogleSheetsClientError,
    GoogleSheetsReadResult,
)
from app.integrations.n8n_client import N8nClient, N8nIntegrationResult  # noqa: F401
from app.integrations.supabase_admin_client import (  # noqa: F401
    InviteRedirectNotAllowedError,
    SupabaseAdminClient,
    SupabaseAdminClientError,
)

__all__ = [
    "N8nClient",
    "N8nIntegrationResult",
    "GoogleSheetsClient",
    "GoogleSheetsClientError",
    "GoogleSheetsReadResult",
    "SupabaseAdminClient",
    "SupabaseAdminClientError",
    "InviteRedirectNotAllowedError",
]
