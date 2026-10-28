# Template de e-mail de redefinição de senha (Supabase Auth)

> ATENÇÃO: isto altera o projeto Supabase (Auth › Email Templates). Só aplique
> com autorização do dono do projeto. Nada neste repositório altera o painel.

## Diagnóstico (2026-10-27, com evidência nos logs do projeto)

Relato: usuários dizem que o link de "Enviar redefinição de senha" de
`/administracao/usuarios` **chega expirado**.

Os logs do Supabase (`edge_logs` + `auth_logs`, 2026-10-27) mostram que NÃO é
expiração de tempo. Para **todos** os tokens emitidos no dia, o PRIMEIRO
acesso a `/auth/v1/verify` partiu de um IP da Amazon nos EUA entre 2 e 4
segundos após o `mail.send`, retornou 303 com SUCESSO e criou sessão. Todos os
acessos seguintes — inclusive o clique do usuário real, de IP da CLARO/BR,
6 a 11 minutos depois — falharam com:

```
403: Email link is invalid or has expired
error: One-time token not found
```

`One-time token not found` = token JÁ CONSUMIDO, não vencido. A tabela
`auth.one_time_tokens` estava com 0 linhas. Também há `HEAD /auth/v1/verify`
de `104.47.*` (Microsoft Exchange Online Protection / Safe Links) sem
User-Agent.

Causa: o template padrão usa `{{ .ConfirmationURL }}`, que aponta para
`/auth/v1/verify` — um GET de uso único. O scanner de links do provedor de
e-mail do destinatário abre o link automaticamente e GASTA o token antes do
clique da pessoa. A documentação oficial do Supabase descreve exatamente isto
em Email Templates › "Email prefetching", citando o Safe Links do Microsoft
Defender for Office 365.

Aumentar o "Email OTP Expiration" NÃO resolve: só amplia a janela em que o
scanner pode consumir o token.

### Consequência de segurança (fluxo implícito)

Como o fluxo é implícito, o 303 do `/auth/v1/verify` devolve `access_token` e
`refresh_token` no fragmento da URL. Os scanners que detonaram os links
RECEBERAM credenciais válidas e as sessões ficaram ativas (`not_after = null`).
Ao aplicar esta correção, encerre também as sessões dos usuários afetados
(tela `/administracao/usuarios` › "Encerrar sessões", que preenche
`sessions_revoked_at` e barra inclusive tokens renovados — ver
`backend/app/auth/supabase_auth.py:199-217`).

## Correção

O e-mail passa a apontar para a página `/ativar-conta` com `token_hash` na
query string. Um GET do scanner apenas CARREGA a página, que não consome
nada: `verifyOtp({ token_hash, type: 'recovery' })` só é chamado depois do
clique da pessoa no botão "Continuar"
(`frontend/src/app/(publico)/ativar-conta/page.tsx:270-279`).

Pré-requisito: o frontend em produção precisa ser a build de 2026-10-21 ou
posterior (a que aceita `type=recovery`). Verificação sem queimar token real:
abrir `https://ueato.revizzicar.com.br/ativar-conta?token_hash=teste123&type=recovery`
e conferir que o título é **"Redefinir senha"** (e não "Ativar conta" nem
"Link de convite inválido"). Nada é consumido enquanto não se clica.

Variáveis: `{{ .RedirectTo }}` (o `redirect_to` enviado pelo backend, já
validado na allow-list `INVITE_ALLOWED_REDIRECT_URLS`) e `{{ .TokenHash }}`.

## HTML do template "Reset Password"

Assunto sugerido: `Redefinição de senha do SISPAT-AGU`

```html
<h2>Redefinição de senha do SISPAT-AGU</h2>
<p>Olá,</p>
<p>Um administrador solicitou a redefinição da senha da sua conta no Sistema
de Gestão Patrimonial da AGU (SISPAT-AGU).</p>
<p>Para criar uma nova senha, clique no botão abaixo:</p>
<p>
  <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery"
     style="display:inline-block;padding:12px 24px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">
    Criar nova senha
  </a>
</p>
<p>Se o botão não funcionar, copie e cole este endereço no navegador:</p>
<p>{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery</p>
<p>Sua senha atual continua valendo até você concluir a troca. O link é
pessoal, de uso único e tem validade limitada: use sempre o e-mail MAIS
RECENTE, porque um novo pedido invalida o link anterior.</p>
<p>Se você não esperava este e-mail, ignore-o: nenhuma senha será alterada
sem o seu clique. Por segurança, nunca compartilhe este link.</p>
```

Se no e-mail de teste o link vier sem domínio (`{{ .RedirectTo }}` vazio),
troque `{{ .RedirectTo }}` por `{{ .SiteURL }}/ativar-conta` nas DUAS
ocorrências.

Atenção: use `type=recovery`. Copiar o HTML do convite mantendo `type=invite`
faz o GoTrue recusar o token com a MESMA mensagem de "expirado".

## Passos no painel

1. Supabase › Authentication › Emails › Templates › "Reset Password".
2. Cole o assunto e o HTML acima; salve.
3. Aplique o mesmo tratamento ao template "Invite user"
   (`docs/deploy/email-template-convite.md`), hoje igualmente quebrado:
   os logs mostram o convite de 2026-10-27 18:54 também consumido por scanner.

## Como testar

1. Em `/administracao/usuarios`, peça "Redefinir senha" para um usuário de
   teste que você controle. Faça UM pedido só.
2. No e-mail, passe o mouse no botão: o link deve ser
   `https://ueato.revizzicar.com.br/ativar-conta?token_hash=...&type=recovery`
   (nunca `...supabase.co/auth/v1/verify...`).
3. Em Authentication › Logs: NÃO deve haver `verify` antes do seu clique.
   Um GET na página `/ativar-conta` pelo scanner é esperado e inofensivo.
4. Clique em "Continuar", defina a nova senha: deve concluir e levar ao login.
5. Reabrir o mesmo link depois deve mostrar erro amigável (token já usado).

## Limite de e-mail do SMTP embutido

Os logs confirmam remetente `noreply@mail.app.supabase.io` (SMTP embutido do
Supabase): limite de ~2 mensagens por hora e entrega apenas a membros do
projeto. Dois pedidos de recuperação foram disparados em 4 minutos em
2026-10-27, consumindo a cota da hora. Configure SMTP próprio (Auth › SMTP
Settings) com SPF/DKIM/DMARC antes do uso real — ver item 1.3 de
`docs/deploy/PENDENCIAS_OPERACIONAIS_2026-10-20.md`.
