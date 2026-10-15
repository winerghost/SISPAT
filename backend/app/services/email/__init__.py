"""Envio de e-mail seguro (SMTP), DESLIGADO por padrao (EMAIL_ENABLED=false).

Submodulos (importe-os diretamente; este pacote nao importa nada para evitar
ciclos com `app.config.settings`):
    address   validacao estrita de endereco unico + mascara para logs
    templates templates fixos com autoescape (nenhum HTML vindo do cliente)
    sender    EmailSender / SmtpEmailSender / NullEmailSender / EmailSendError
    dispatch  send_email_safely (teto por hora, auditoria, nunca levanta)
"""
