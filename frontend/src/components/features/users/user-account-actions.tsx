"use client";

import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { LogOut, Mail, Power, ShieldOff } from "lucide-react";
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
  resetUserMfa,
  revokeUserSessions,
  sendPasswordReset,
  type UserSummary,
} from "@/lib/users-api";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import {
  formatDateTime,
  isReauthRequired,
  isVersionConflict,
  REAUTH_MESSAGE,
  userErrorMessage,
} from "./user-labels";

// =============================================================================
// Conta — ações administrativas sobre a conta (contrato: Etapa 2, "Ações de
// conta"). Cada ação abre uma confirmação que diz EXATAMENTE o que acontece;
// o resultado exibido é o que o backend devolveu (nunca otimista).
// Resetar MFA exige reautenticação recente: em 403 `REAUTH_REQUIRED` o mesmo
// diálogo pede o código do autenticador do ADM (desafio TOTP do login, via
// `reverifyTotp`) e, verificado, repete a chamada. Sem fator TOTP, orienta a
// sair e entrar de novo.
// =============================================================================

type Action = "deactivate" | "activate" | "sessions" | "password" | "mfa";

type Outcome =
  | { kind: "user"; user: UserSummary }
  | { kind: "sessions"; at: string }
  | { kind: "password"; result: "sent" | "unavailable" }
  | { kind: "mfa"; removed: number };

const REASON_MAX = 1000;

export interface UserAccountActionsProps {
  user: UserSummary;
  isSelf: boolean;
  onUpdated: (user: UserSummary) => void;
  onConflict: () => void;
}

export function UserAccountActions({ user, isSelf, onUpdated, onConflict }: UserAccountActionsProps) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reauthStep, setReauthStep] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const mutation = useMutation<Outcome, unknown, Action>({
    mutationFn: async (current) => {
      switch (current) {
        case "deactivate":
          return {
            kind: "user",
            user: await deactivateUser(user.id, {
              version: user.version,
              ...(reason.trim() ? { reason: reason.trim().slice(0, REASON_MAX) } : {}),
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
      }
    },
    onError: (cause, current) => {
      if (isVersionConflict(cause)) {
        closeDialog();
        onConflict();
        return;
      }
      if (current === "mfa" && isReauthRequired(cause)) {
        setReauthStep(true);
        setCode("");
        setError(null);
        return;
      }
      setError(userErrorMessage(cause, "Não foi possível concluir a ação agora. Tente novamente."));
    },
  });

  function open(next: Action) {
    setResult(null);
    setError(null);
    setReason("");
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
      mutation.mutate("mfa");
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
          Esta é a sua conta. Desativar, encerrar sessões e resetar o MFA da própria conta devem ser feitos por
          outro administrador. Para sair de todos os dispositivos, use “Sair”.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3" aria-label="Ações da conta">
        {user.active ? (
          <ActionRow
            icon={<Power aria-hidden />}
            title="Desativar conta"
            text="Bloqueia o acesso e encerra todas as sessões. Dados e histórico são mantidos."
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
          description={reauthStep ? REAUTH_MESSAGE : dialog.description}
          consequences={
            reauthStep
              ? [
                  "Abra o aplicativo autenticador cadastrado na sua conta (o mesmo usado para entrar).",
                  "Digite o código de 6 dígitos. Depois de confirmado, o reset do MFA é enviado automaticamente.",
                ]
              : dialog.consequences
          }
          confirmLabel={reauthStep ? "Confirmar código" : dialog.confirmLabel}
          pendingLabel={reauthStep || verifying ? "Confirmando…" : dialog.pendingLabel}
          pending={pending}
          error={error}
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

interface DialogText {
  title: string;
  description: string;
  consequences: string[];
  confirmLabel: string;
  pendingLabel: string;
}

const DIALOGS: Record<Action, (user: UserSummary) => DialogText> = {
  deactivate: (user) => ({
    title: "Desativar conta",
    description: `Desativar a conta de ${user.name} (${user.email})?`,
    consequences: [
      "A pessoa não conseguirá mais entrar no sistema.",
      "Todas as sessões abertas, em qualquer dispositivo, são encerradas imediatamente.",
      "Perfil, unidades e histórico são mantidos; a conta pode ser reativada depois.",
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

