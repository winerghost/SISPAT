"""Pacote da API REST do SISPAT-AGU, organizado por versão.

Cada subpacote (ex.: `app.api.v1`) expõe seu próprio blueprint agregador,
registrado em `app.create_app()`. Futuras versões da API (ex.: `api.v2`)
devem seguir o mesmo padrão, preservando compatibilidade com versões
anteriores enquanto necessário.
"""
