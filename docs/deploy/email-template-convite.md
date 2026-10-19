# Template de e-mail do convite (Supabase Auth)

> ATENÇÃO: isto altera o projeto Supabase (Auth › Email Templates). Só aplique
> com autorização do dono do projeto. Nada neste repositório altera o painel.

## Diagnóstico

Os logs do Supabase Auth mostram que o link do convite
(`{{ .ConfirmationURL }}`) é consumido 2–6 s após o envio por scanners de
e-mail (antivírus/anti-phishing do provedor do destinatário) que abrem os
links automaticamente. O link do template padrão é de uso único: ao ser
aberto pelo scanner o token é gasto, e o clique do usuário resulta em
`otp_expired`.

Correção: o e-mail passa a apontar para a nossa página `/ativar-conta` com
`token_hash` na query string. Um GET do scanner apenas carrega a página (que
não consome nada); a página chama `verifyOtp({ token_hash, type: 'invite' })`
somente após o clique do usuário em um botão.

Variáveis usadas (conforme a documentação de Email Templates do Supabase):
`{{ .RedirectTo }}` (o `redirect_to` enviado pelo backend, já validado na
allow-list), `{{ .TokenHash }}` e `type=invite` (aceito por `verifyOtp`).

Nota de verificação: a consulta via `mcp__supabase__search_docs` não estava
disponível nesta sessão; os nomes acima seguem a documentação pública
conhecida. Confirme em https://supabase.com/docs/guides/auth/auth-email-templates
antes de colar. Se `{{ .RedirectTo }}` vier vazio no e-mail enviado, use
`{{ .SiteURL }}/ativar-conta` no lugar.

## Pré-requisitos

1. `INVITE_ALLOWED_REDIRECT_URLS` com o 1º item terminando em `/ativar-conta`
   (o backend recusa o convite caso contrário).
2. A mesma URL em Auth › URL Configuration › Redirect URLs. Site URL no
   domínio final.

## HTML do template "Invite user"

Assunto sugerido: `Convite de acesso ao SISPAT-AGU`

```html
<h2>Convite de acesso ao SISPAT-AGU</h2>
<p>Olá,</p>
<p>Você foi convidado(a) para acessar o Sistema de Gestão Patrimonial da AGU
(SISPAT-AGU).</p>
<p>Para ativar sua conta e definir sua senha, clique no botão abaixo:</p>
<p>
  <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite"
     style="display:inline-block;padding:12px 24px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">
    Ativar minha conta
  </a>
</p>
<p>Se o botão não funcionar, copie e cole este endereço no navegador:</p>
<p>{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite</p>
<p>Este convite é pessoal e tem validade limitada. Se você não esperava este
e-mail, ignore-o: nenhuma conta será ativada sem o seu clique.</p>
<p>Por segurança, nunca compartilhe este link.</p>
```

Sem imagens remotas, sem segredos (o `token_hash` é o valor emitido pelo
Supabase para este destinatário).

## Passos no painel

1. Supabase › Authentication › Emails › Templates › "Invite user".
2. Cole o assunto e o HTML acima; salve.
3. Confirme em URL Configuration o Site URL e as Redirect URLs.

## Como testar

1. Com o frontend (`/ativar-conta` novo) e o backend no ar, convide um e-mail
   de teste que você controle.
2. Abra a mensagem: o link deve apontar para
   `<domínio>/ativar-conta?token_hash=...&type=invite`.
3. Confira nos logs do Auth que NÃO há `verify` antes do seu clique.
4. Clique em "Ativar minha conta" na página: deve concluir a ativação.
5. Reabrir o mesmo link depois deve mostrar erro amigável (token já usado).

## Limite de e-mail do SMTP embutido

O SMTP padrão do Supabase tem limite muito baixo de envios por hora e retorna
`429 email rate limit exceeded` ao excedê-lo, e só entrega a membros do
projeto em alguns planos. Antes da produção configure SMTP próprio (Auth ›
SMTP Settings) com domínio autenticado (SPF/DKIM/DMARC).
