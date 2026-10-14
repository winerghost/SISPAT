"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { FadeIn, SlideIn } from "@/components/animations";
import { AnimatedFormMessage, AuthField, StepIndicator } from "@/components/features/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "@/components/ui/form-message";
import { Skeleton } from "@/components/ui/skeleton";
import { getSupabaseClient } from "@/lib/supabase-client";
import { activateInvite, ApiError } from "@/lib/users-api";

// =============================================================================
// /ativar-conta — destino do link de convite enviado pelo Supabase Auth
// =============================================================================
// Como a sessão chega a esta página (mecanismo usado pela versão instalada
// do SDK, @supabase/supabase-js 2.117.3):
//
//   O cliente criado em `supabase-client.ts` usa `detectSessionInUrl: true`
//   (o padrão do SDK). Ao ser instanciado — o que acontece de forma lazy,
//   na primeira chamada a `getSupabaseClient()` abaixo —, o GoTrueClient
//   dispara internamente `_initialize()`, que INSPECIONA A URL ATUAL
//   (`window.location.href`) e detecta automaticamente, sem nenhuma chamada
//   explícita nossa:
//     - formato implícito: `#access_token=...&refresh_token=...&type=invite`
//       no hash (fluxo padrão do SDK, `flowType: 'implicit'`);
//     - formato PKCE: `?code=...` na query string (caso o projeto Supabase
//       esteja configurado para `flowType: 'pkce'` nos links de e-mail).
//   Em ambos os casos o SDK troca o token/código por uma sessão válida,
//   limpa a URL e notifica os assinantes de `onAuthStateChange`.
//
//   Por isso este componente NÃO chama `exchangeCodeForSession`/
//   `getSessionFromUrl` manualmente: basta `await supabase.auth.getSession()`
//   (que aguarda essa inicialização internamente) para obter o resultado, e
//   assinar `onAuthStateChange` para cobrir o caso em que o evento chega
//   depois da primeira leitura. Se nenhuma sessão aparecer, o link é
//   tratado como inválido/expirado.
//
// Fluxo após a sessão existir:
//   1. Usuário define a senha (`supabase.auth.updateUser({ password })`).
//   2. Em sucesso, chama `POST /api/v1/users/activate-invite` (sem corpo —
//      o backend identifica o convite pela sessão/token atual).
//   3. 404/409 do backend = convite inválido/expirado — mensagem clara,
//      orientando a solicitar um novo convite ao administrador.
// =============================================================================

type Phase = "checking" | "ready" | "invalid" | "activated";

// Apresentação: indicador de etapas (reflete só a fase REAL), skeleton enquanto
// o link é validado, troca de fase com fade (FadeIn), erro com entrada
// discreta (AnimatedFormMessage, role="alert") e `<Button loading>`.
const ACTIVATION_STEPS = ["Validar convite", "Definir senha", "Conta ativada"];

export default function AtivarContaPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activatedRole, setActivatedRole] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseClient();

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setPhase(data.session ? "ready" : "invalid");
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (session) setPhase((current) => (current === "activated" ? current : "ready"));
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = getSupabaseClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError("Não foi possível definir a senha agora. Tente novamente.");
        setSubmitting(false);
        return;
      }

      const result = await activateInvite();
      setActivatedRole(result.role);
      setPhase("activated");
    } catch (cause) {
      setError(activateErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const stepIndex = phase === "checking" ? 0 : phase === "ready" ? 1 : ACTIVATION_STEPS.length;

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4 sm:p-8">
      <SlideIn
        distance="sm"
        className="flex w-full max-w-sm flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-heading text-[28px] text-bone">Ativar conta</h1>
        </div>

        {phase !== "invalid" && (
          <StepIndicator label="Etapas da ativação" steps={ACTIVATION_STEPS} current={stepIndex} />
        )}

        {phase === "checking" && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <p role="status" className="text-body-sm text-warm-granite">
              Validando seu link de convite…
            </p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {phase === "invalid" && (
          <FadeIn className="flex flex-col gap-3">
            <FormMessage>
              Este link de convite é inválido ou já expirou. Solicite um novo convite a um
              administrador.
            </FormMessage>
            <Link
              href="/login"
              className="inline-flex min-h-6 items-center self-start text-body-sm text-bone underline underline-offset-4"
            >
              Ir para o login
            </Link>
          </FadeIn>
        )}

        {phase === "ready" && (
          <FadeIn>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              <p className="text-body-sm text-warm-granite">
                Defina uma senha (mínimo de 8 caracteres) para concluir a ativação da sua conta.
              </p>

              <AuthField label="Nova senha">
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "ativar-erro" : undefined}
                />
              </AuthField>

              <AuthField label="Confirmar senha">
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "ativar-erro" : undefined}
                />
              </AuthField>

              <AnimatedFormMessage id="ativar-erro" message={error} />

              <Button type="submit" loading={submitting} className="w-full">
                {submitting ? "Ativando…" : "Ativar conta"}
              </Button>
            </form>
          </FadeIn>
        )}

        {/* Sucesso: só após a resposta real do backend (phase "activated"). */}
        {phase === "activated" && (
          <FadeIn className="flex flex-col gap-3">
            <p role="status" className="flex items-start gap-2 text-body-sm text-metric-green">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                Conta ativada com sucesso{activatedRole ? ` como ${activatedRole}` : ""}. Você já
                pode entrar com seu e-mail e a nova senha.
              </span>
            </p>
            <Button asChild className="w-full">
              <Link href="/login">Ir para o login</Link>
            </Button>
          </FadeIn>
        )}
      </SlideIn>
    </div>
  );
}

function activateErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 404 || cause.status === 409) {
      return "Este convite não é mais válido. Solicite um novo convite a um administrador.";
    }
    if (cause.status === 401) {
      return "Sua sessão de ativação expirou. Abra o link de convite novamente.";
    }
  }
  return "Não foi possível concluir a ativação agora. Tente novamente.";
}
