"use client";

import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { LogOut, Mail, Power, ShieldOff, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";

import { FadeIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField, textareaControlClassName } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { reverifyTotp } from "@/lib/mfa";
import {
  activateUser,
  deactivateUser,
  deleteUser,
  resetUserMfa,
  revokeUserAccess,
  revokeUserSessions,
  sendPasswordReset,
  type UserSummary,
} from "@/lib/users-api";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import {
  DELETE_CONFIRM_MISMATCH,
  formatDateTime,
  isBadRequest,
  isConfirmationMismatch,
  isConflict,
  isReauthRequired,
  isVersionConflict,
  REAUTH_MESSAGE,
  REAUTH_MESSAGE_DELETE,
  userErrorMessage,
} from "./user-labels";

// =============================================================================
// Conta — ações administrativas sobre a conta (contrato: Etapa 2, "Ações de
// conta"). Cada ação abre uma confirmação que diz EXATAMENTE o que acontece;
// o resultado exibido é o que o backend devolveu (nunca otimista).
//
// São SETE ações, em dois grupos visualmente separados, porque "desativar",
// "revogar" e "excluir" são coisas diferentes e o ADM não pode confundi-las:
//  - reversíveis: desativar/reativar, encerrar sessões, redefinir senha;
//  - alto impacto: resetar MFA, revogar todo o acesso (`POST /revoke`) e
//    EXCLUIR definitivamente (`POST /delete`, exclusão lógica + anonimização).
//
// Exclusão exige confirmação FORTE: digitar o e-mail exato do alvo, que vai no
// corpo como `confirm_text`. O gate do botão é só UX — quem valida o texto, o
// `version`, o escopo de unidade, o "último ADM" e a própria permissão de
// excluir é o BACKEND. Esconder o botão não é controle de acesso.
//
// Reautenticação: em 403 `REAUTH_REQUIRED` (reset de MFA e, se o backend
// pedir, exclusão) o mesmo diálogo pede o código do autenticador do ADM
// (desafio TOTP do login, via `reverifyTotp`) e, verificado, repete a MESMA
// ação. Sem fator TOTP, orienta a sair e entrar de novo.
// =============================================================================

type Action = "deactivate" | "activate" | "sessions" | "password" | "mfa" | "revoke" | "delete";

type Outcome =
  | { kind: "user"; user: UserSummary }
  | { kind: "sessions"; at: string }
  | { kind: "password"; result: "sent" | "unavailable" }
  | { kind: "mfa"; removed: number }
  | { kind: "revoke" }
  | { kind: "deleted"; user: UserSummary };

const REASON_MAX = 1000;

/** Ações que exigem reautenticação TOTP quando o backend responde 403. */
const REAUTH_ACTIONS: ReadonlySet<Action> = new Set<Action>(["mfa", "delete"]);

export interface UserAccountActionsProps {
  user: UserSummary;
  isSelf: boolean;
  onUpdated: (user: UserSummary) => void;
  onConflict: () => void;
  /** Revogação total: não devolve o resumo, o pai recarrega tudo. */
  onRevoked: () => void;
  /**
   * Exclusão concluída: o usuário sai da listagem e o painel é fechado pelo
   * pai. Recebe o resumo JÁ ANONIMIZADO devolvido pelo backend.
   */
  onDeleted: (user: UserSummary) => void;
}

export function UserAccountActions({
  user,
  isSelf,
  onUpdated,
  onConflict,
  onRevoked,
  onDeleted,
}: UserAccountActionsProps) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reauthStep, setReauthStep] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // WCAG 2.4.3: o botão que abre a confirmação vive DENTRO do painel lateral
  // (que já é um `role="dialog"`), então o `DialogContent` não consegue
  // guardá-lo sozinho — ele ignora origens internas a outro diálogo.
  const triggerRef = useRef<HTMLElement | null>(null);

  const trimmedReason = reason.trim().slice(0, REASON_MAX);

  const mutation = useMutation<Outcome, unknown, Action>({
    mutationFn: async (current) => {
      switch (current) {
        case "deactivate":
          return {
            kind: "user",
            user: await deactivateUser(user.id, {
              version: user.version,
              ...(trimmedReason ? { reason: trimmedReason } : {}),
            }),
          };
        case "activate":
          return { kind: "user", user: await activateUser(user.id, user.version) };
        case "sessions":
          return { kind: "sessions", at: (await revokeUserSessions(user.id)).sessions_revoked_at };
        case "password":
          return { kind: "password", result: (await sendPasswordReset(user.id)).result };
        case "mfa":
          return { kind: "mfa", removed: (await resetUserMfa(user.id)).removed_factors };
        case "revoke":
          await revokeUserAccess(user.id, trimmedReason ? { reason: trimmedReason } : {});
          return { kind: "revoke" };
        case "delete":
          return {
            kind: "deleted",
            // `confirm_text` vai exatamente como digitado (sem normalizar): a
            // comparação que vale é a do backend.
            user: await deleteUser(user.id, { version: user.version, confirm_text: confirmText.trim() }),
          };
      }
    },
    onSuccess: (outcome) => {
      closeDialog();
      switch (outcome.kind) {
        case "user":
          toast.success(outcome.user.active ? "Conta reativada." : "Conta desativada.");
          setResult({
            tone: "success",
            text: outcome.user.active
              ? "Conta reativada. A pessoa já pode entrar novamente."
              : "Conta desativada e sessões encerradas.",
          });
          onUpdated(outcome.user);
          break;
        case "sessions":
          setResult({
            tone: "success",
            text: `Sessões encerradas em ${formatDateTime(outcome.at) ?? "agora"}. A pessoa precisará entrar de novo.`,
          });
          break;
        case "password":
          setResult(
            outcome.result === "sent"
              ? { tone: "success", text: `E-mail de redefinição de senha enviado para ${user.email}.` }
              : {
                  tone: "error",
                  text: "O envio de e-mail está indisponível no momento. Nada foi alterado; tente novamente mais tarde.",
                },
          );
          break;
        case "mfa":
          setResult({
            tone: "success",
            text:
              outcome.removed === 0
                ? "Nenhum fator de verificação estava cadastrado. Nada foi removido."
                : `Verificação em duas etapas resetada: ${outcome.removed} fator(es) removido(s). No próximo acesso a pessoa configurará um novo autenticador.`,
          });
          break;
        case "revoke":
          toast.success("Acesso revogado.");
          setResult({
            tone: "success",
            text: "Acesso revogado: perfil e unidades removidos, conta desativada e sessões encerradas. Para devolver o acesso, escolha um perfil e as unidades de novo e reative a conta.",
          });
          onRevoked();
          break;
        case "deleted":
          toast.success("Usuário excluído.");
          onDeleted(outcome.user);
          break;
      }
    },
    onError: (cause, current) => {
      if (isVersionConflict(cause)) {
        closeDialog();
        onConflict();
        return;
      }
      if (REAUTH_ACTIONS.has(current) && isReauthRequired(cause)) {
        setReauthStep(true);
        setCode("");
        setError(null);
        return;
      }
      setError(errorTextFor(current, cause));
    },
  });

  function open(next: Action) {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setResult(null);
    setError(null);
    setReason("");
    setConfirmText("");
    setReauthStep(false);
    setCode("");
    setAction(next);
  }

  function closeDialog() {
    setAction(null);
    setReauthStep(false);
    setCode("");
    setError(null);
  }

  async function confirmReauth() {
    const current = action;
    if (!current) return;
    if (!code.trim()) {
      setError("Informe o código de 6 dígitos do seu aplicativo autenticador.");
      return;
    }
    setVerifying(true);
    setError(null);
    const outcome = await reverifyTotp(code);
    setVerifying(false);
    if (outcome === "verified") {
      setReauthStep(false);
      mutation.mutate(current);
      return;
    }
    setCode("");
    setError(
      outcome === "invalid_code"
        ? "Código inválido ou expirado. Confira o aplicativo autenticador e tente de novo."
        : outcome === "no_factor"
          ? "Não encontramos um autenticador na sua conta. Saia do sistema e entre novamente confirmando o código para continuar."
          : "Não foi possível confirmar o código agora. Se persistir, saia do sistema e entre novamente.",
    );
  }

  const pending = mutation.isPending || verifying;

  const dialog = action ? DIALOGS[action](user) : null;
  const isDelete = action === "delete";
  // Gate só de UX: compara ignorando caixa/espaços para não punir quem digita
  // com maiúsculas. A validação real (`confirm_text`) é do backend (400).
  const confirmMatches = confirmText.trim().toLowerCase() === user.email.trim().toLowerCase();

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
        <dt className="text-warm-granite">Situação</dt>
        <dd>
          <Badge variant={user.active ? "success" : "default"}>{user.active ? "Ativa" : "Desativada"}</Badge>
        </dd>
        <dt className="text-warm-granite">Criada em</dt>
        <dd className="text-bone">{formatDateTime(user.created_at) ?? "—"}</dd>
        <dt className="text-warm-granite">Último acesso</dt>
        <dd className="text-bone">{formatDateTime(user.last_login_at) ?? "Nunca"}</dd>
        {!user.active && user.deactivated_at ? (
          <>
            <dt className="text-warm-granite">Desativada em</dt>
            <dd className="text-bone">{formatDateTime(user.deactivated_at)}</dd>
          </>
        ) : null}
      </dl>

      {isSelf ? (
        <p className="rounded-cards border border-ash-stroke px-4 py-3 text-body-sm text-pale-stone">
          Esta é a sua conta. Desativar, excluir, revogar o acesso, encerrar sessões e resetar o MFA da própria
          conta devem ser feitos por outro administrador. Para sair de todos os dispositivos, use “Sair”.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3" aria-label="Ações da conta">
        {user.active ? (
          <ActionRow
            icon={<Power aria-hidden />}
            title="Desativar conta"
            text="Bloqueia o acesso e encerra todas as sessões. Dados e histórico são mantidos e a conta pode ser reativada — não é exclusão."
            label="Desativar conta"
            destructive
            disabled={isSelf}
            onClick={() => open("deactivate")}
          />
        ) : (
          <ActionRow
            icon={<Power aria-hidden />}
            title="Reativar conta"
            text="Libera o acesso novamente com o mesmo perfil e unidades."
            label="Reativar conta"
            onClick={() => open("activate")}
          />
        )}
        <ActionRow
          icon={<LogOut aria-hidden />}
          title="Encerrar sessões"
          text="Desconecta a pessoa de todos os dispositivos. A conta continua ativa."
          label="Encerrar sessões"
          disabled={isSelf}
          onClick={() => open("sessions")}
        />
        <ActionRow
          icon={<Mail aria-hidden />}
          title="Redefinição de senha"
          text="Envia um e-mail para a pessoa criar uma nova senha. Você nunca vê o link nem a senha."
          label="Enviar redefinição de senha"
          onClick={() => open("password")}
        />
        <ActionRow
          icon={<ShieldOff aria-hidden />}
          title="Verificação em duas etapas"
          text="Remove os autenticadores cadastrados (ex.: celular perdido). Exige confirmar o seu código."
          label="Resetar MFA"
          destructive
          disabled={isSelf}
          onClick={() => open("mfa")}
        />
      </ul>

      {/*
        Zona separada: aqui estão as duas ações que NÃO são "desativar". A
        borda laranja e o texto de aviso existem para o ADM não trocar uma
        pela outra. Quem pode executá-las é decidido pelo backend.
      */}
      <section
        aria-label="Ações de alto impacto"
        className="flex flex-col gap-3 rounded-cards border border-signal-orange/40 p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-eyebrow text-signal-orange">Ações de alto impacto</h3>
          <p className="text-caption leading-[1.4] text-warm-granite">
            Desativar uma conta é reversível. Revogar o acesso desfaz perfil e unidades (dá para refazer).
            Excluir é definitivo e não tem desfazer.
          </p>
        </div>
        <ul className="flex flex-col gap-3" aria-label="Revogação e exclusão">
          <ActionRow
            icon={<UserX aria-hidden />}
            title="Revogar todo o acesso"
            text="Remove o perfil e TODAS as unidades, cancela convite pendente, desativa a conta e encerra as sessões. A conta e o histórico continuam existindo."
            label="Revogar acesso"
            destructive
            disabled={isSelf}
            onClick={() => open("revoke")}
          />
          <ActionRow
            icon={<Trash2 aria-hidden />}
            title="Excluir usuário definitivamente"
            text="Exclusão irreversível: os dados pessoais são anonimizados e o usuário sai da listagem. O histórico de auditoria é preservado."
            label="Excluir usuário"
            destructive
            disabled={isSelf}
            onClick={() => open("delete")}
          />
        </ul>
      </section>

      <div aria-live="polite">
        {result ? (
          <FadeIn>
            <FormMessage tone={result.tone} data-testid="resultado-acao-conta">
              {result.text}
            </FormMessage>
          </FadeIn>
        ) : null}
      </div>

      {dialog ? (
        <ConfirmActionDialog
          open={!!action}
          onOpenChange={(next) => (next ? undefined : closeDialog())}
          title={reauthStep ? "Confirme sua identidade" : dialog.title}
          description={reauthStep ? (dialog.reauthMessage ?? REAUTH_MESSAGE) : dialog.description}
          consequences={
            reauthStep
              ? [
                  "Abra o aplicativo autenticador cadastrado na sua conta (o mesmo usado para entrar).",
                  "Digite o código de 6 dígitos. Depois de confirmado, a ação é enviada automaticamente.",
                ]
              : dialog.consequences
          }
          confirmLabel={reauthStep ? "Confirmar código" : dialog.confirmLabel}
          pendingLabel={reauthStep || verifying ? "Confirmando…" : dialog.pendingLabel}
          pending={pending}
          // Exclusão: o botão só libera quando o e-mail digitado coincide.
          // Nunca pré-confirmada, nunca em massa.
          confirmDisabled={isDelete && !reauthStep && !confirmMatches}
          error={error}
          onCloseAutoFocus={(event) => {
            const target = triggerRef.current;
            // Ação concluída: o botão pode nem existir mais (ex.: "Desativar"
            // vira "Reativar", exclusão fecha o painel) — aí deixa o Radix.
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onConfirm={() => (reauthStep ? void confirmReauth() : mutation.mutate(action!))}
        >
          {action === "deactivate" && !reauthStep ? (
            <FormField
              id="desativar-motivo"
              label="Motivo (opcional)"
              hint={`Fica registrado na auditoria. Até ${REASON_MAX} caracteres.`}
              surface="light"
            >
              {(field) => (
                <textarea
                  {...field}
                  className={textareaControlClassName}
                  maxLength={REASON_MAX}
                  value={reason}
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
          {action === "revoke" && !reauthStep ? (
            <FormField
              id="revogar-motivo"
              label="Motivo (opcional)"
              hint={`Fica registrado na auditoria. Até ${REASON_MAX} caracteres.`}
              surface="light"
            >
              {(field) => (
                <textarea
                  {...field}
                  className={textareaControlClassName}
                  maxLength={REASON_MAX}
                  value={reason}
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
          {isDelete && !reauthStep ? (
            <FormField
              id="excluir-confirmacao"
              label="Para confirmar, digite o e-mail do usuário"
              required
              hint={
                <>
                  Digite exatamente: <span className="break-words [overflow-wrap:anywhere]">{user.email}</span>
                </>
              }
              surface="light"
            >
              {(field) => (
                <Input
                  {...field}
                  type="email"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  maxLength={320}
                  autoFocus
                  value={confirmText}
                  disabled={pending}
                  onChange={(event) => setConfirmText(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
          {reauthStep ? (
            <FormField id="reauth-codigo" label="Código do autenticador" surface="light">
              {(field) => (
                <Input
                  {...field}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={10}
                  placeholder="000000"
                  autoFocus
                  value={code}
                  disabled={pending}
                  onChange={(event) => setCode(event.target.value)}
                />
              )}
            </FormField>
          ) : null}
        </ConfirmActionDialog>
      ) : null}
    </div>
  );
}

/** Mensagem humana por ação; nunca o texto cru do backend. */
function errorTextFor(current: Action, cause: unknown): string {
  if (current === "delete") {
    // `400 confirmation_mismatch`: o e-mail digitado não é o do alvo. Outro
    // 400 só acontece se o corpo for recusado (nunca deveria, é montado aqui).
    if (isConfirmationMismatch(cause)) return DELETE_CONFIRM_MISMATCH;
    if (isBadRequest(cause)) {
      return "O pedido de exclusão não foi aceito pelo servidor. Nada foi alterado; recarregue a página e tente de novo.";
    }
    // 409 vem em três sabores (`version_conflict` já foi tratado antes,
    // `self_change_forbidden` e `last_admin` têm texto próprio) e 403/404/429/
    // 503 também — todos resolvidos por `userErrorMessage`, pelo CÓDIGO.
    return userErrorMessage(
      cause,
      "Não foi possível excluir este usuário agora. Nada foi alterado; tente novamente.",
    );
  }
  if (current === "revoke") {
    if (isConflict(cause)) {
      return "Não foi possível revogar: ou é a sua própria conta, ou esta pessoa é o último administrador (ADM) ativo do sistema. Nada foi alterado.";
    }
    return userErrorMessage(cause, "Não foi possível revogar o acesso agora. Nada foi alterado; tente novamente.");
  }
  return userErrorMessage(cause, "Não foi possível concluir a ação agora. Tente novamente.");
}

interface DialogText {
  title: string;
  description: string;
  consequences: string[];
  confirmLabel: string;
  pendingLabel: string;
  /** Texto do passo de reautenticação, quando a ação pode exigi-lo. */
  reauthMessage?: string;
}

const DIALOGS: Record<Action, (user: UserSummary) => DialogText> = {
  deactivate: (user) => ({
    title: "Desativar conta",
    description: `Desativar a conta de ${user.name} (${user.email})?`,
    consequences: [
      "A pessoa não conseguirá mais entrar no sistema.",
      "Todas as sessões abertas, em qualquer dispositivo, são encerradas imediatamente.",
      "Perfil, unidades e histórico são mantidos; a conta pode ser reativada depois.",
      "Isto NÃO é exclusão: nome, e-mail e vínculos continuam no sistema.",
      "A ação fica registrada na auditoria com o seu usuário e o motivo, se informado.",
    ],
    confirmLabel: "Desativar conta",
    pendingLabel: "Desativando…",
  }),
  activate: (user) => ({
    title: "Reativar conta",
    description: `Reativar a conta de ${user.name} (${user.email})?`,
    consequences: [
      "A pessoa poderá entrar de novo com a mesma senha.",
      "O perfil e as unidades atuais continuam valendo.",
      "As sessões encerradas na desativação não voltam: ela precisará entrar de novo.",
    ],
    confirmLabel: "Reativar conta",
    pendingLabel: "Reativando…",
  }),
  sessions: (user) => ({
    title: "Encerrar sessões",
    description: `Encerrar todas as sessões de ${user.name}?`,
    consequences: [
      "A pessoa é desconectada de todos os navegadores e dispositivos.",
      "A conta continua ativa: basta entrar de novo com e-mail, senha e, se houver, o código do autenticador.",
    ],
    confirmLabel: "Encerrar sessões",
    pendingLabel: "Encerrando…",
  }),
  password: (user) => ({
    title: "Enviar redefinição de senha",
    description: `Enviar um e-mail de redefinição de senha para ${user.email}?`,
    consequences: [
      "A pessoa recebe um link para criar uma nova senha. A senha atual continua válida até ser trocada.",
      "Você não vê o link nem a nova senha.",
      "Há um limite de 5 envios por hora para a mesma pessoa.",
    ],
    confirmLabel: "Enviar e-mail",
    pendingLabel: "Enviando…",
  }),
  mfa: (user) => ({
    title: "Resetar verificação em duas etapas",
    description: `Remover todos os autenticadores de ${user.name}?`,
    consequences: [
      "Todos os fatores de verificação em duas etapas (TOTP) da pessoa são removidos.",
      "No próximo acesso ela terá de cadastrar um novo autenticador (obrigatório para ADM).",
      "Por segurança, você precisa ter confirmado o código do SEU autenticador nos últimos 5 minutos — se não, ele será pedido.",
      "A ação é registrada na auditoria como evento de alta criticidade.",
    ],
    confirmLabel: "Resetar MFA",
    pendingLabel: "Resetando…",
  }),
  revoke: (user) => ({
    title: "Revogar todo o acesso",
    description: `Revogar todo o acesso de ${user.name} (${user.email})?`,
    consequences: [
      "O perfil é removido e TODOS os vínculos de unidade são apagados: a pessoa fica sem permissão nenhuma.",
      "Se houver convite pendente para ela, o convite é cancelado.",
      "A conta é desativada e todas as sessões são encerradas na hora.",
      "A conta, o nome, o e-mail e o histórico continuam no sistema — isto NÃO exclui o usuário.",
      "Dá para refazer: escolha um perfil e as unidades de novo e reative a conta.",
      "O sistema recusa revogar o seu próprio acesso e o do último administrador (ADM) ativo.",
    ],
    confirmLabel: "Revogar acesso",
    pendingLabel: "Revogando…",
  }),
  delete: (user) => ({
    title: "Excluir usuário definitivamente",
    description: `Excluir ${user.name} (${user.email})? Esta ação é irreversível.`,
    consequences: [
      "É irreversível: não existe desfazer, lixeira nem restauração. Depois de confirmar, não há como recuperar os dados desta pessoa.",
      "Os dados pessoais são anonimizados: nome, e-mail, telefone e foto são apagados ou substituídos por um rótulo sem identificação.",
      "O histórico de auditoria é preservado: os registros dos eventos não são apagados. Mas o usuário excluído deixa de aparecer na tela de auditoria e, onde o identificador dele surgir, será o rótulo anonimizado — nunca o nome ou o e-mail original.",
      "O acesso termina na hora: perfil e unidades removidos, sessões encerradas e autenticadores (MFA) apagados.",
      "O usuário desaparece da listagem. Para dar acesso de novo é preciso enviar um convite novo.",
      "Se você só quer bloquear o acesso por um tempo, cancele e use “Desativar conta”, que é reversível.",
    ],
    confirmLabel: "Excluir definitivamente",
    pendingLabel: "Excluindo…",
    reauthMessage: REAUTH_MESSAGE_DELETE,
  }),
};

function ActionRow({
  icon,
  title,
  text,
  label,
  destructive = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-cards border border-ash-stroke p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-warm-granite [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body-sm text-bone">{title}</span>
          <span className="text-caption leading-[1.4] text-warm-granite">{text}</span>
        </div>
      </div>
      <Button
        variant={destructive ? "destructive" : "outline"}
        size="sm"
        className="shrink-0 self-start sm:self-center"
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
    </li>
  );
}
