"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
// Como a sessão chega a esta página — DOIS caminhos:
//
//   1) Fluxo atual (token_hash). O e-mail traz
//      `/ativar-conta?token_hash=<hash>&type=invite`. Scanners de e-mail fazem
//      GET automático em todo link e consumiriam um link de uso único
//      (`otp_expired` para o usuário), por isso esta página NÃO consome o
//      token ao carregar: lê `token_hash`/`type` de `window.location.search`,
//      remove-os da URL (history.replaceState), guarda o hash só em memória
//      (ref/estado; nunca localStorage/sessionStorage, nunca logado) e mostra a
//      fase "confirm". Só o clique em "Continuar" chama
//      `supabase.auth.verifyOtp({ token_hash, type: "invite" })`, que cria a
//      sessão. No cliente só se valida o FORMATO; a autoridade é do
//      Supabase/backend. Falha (expirado/usado) -> fase "invalid", sem
//      detalhes do erro.
//
//   2) Fluxo legado (convites já enviados). O cliente de `supabase-client.ts`
//      usa `detectSessionInUrl: true`: ao ser instanciado, o SDK detecta
//      `#access_token=...&type=invite` (implícito) ou `?code=...` (PKCE),
//      troca por sessão e limpa a URL. Basta `getSession()` + assinar
//      `onAuthStateChange`. Sem sessão -> "invalid".
//
//   Também: `#error=access_denied&error_code=otp_expired` (hash) -> "invalid".
//   A rota "/" NÃO redireciona esse hash para cá: "/" é protegida (AuthGuard
//   leva ao /login) e interpretar hash na raiz aumenta superfície (redirect
//   com dado da URL) por pouco ganho; os e-mails novos apontam direto para cá.
//
// Fluxo após a sessão existir:
//   1. Usuário define a senha (`supabase.auth.updateUser({ password })`).
//   2. Em sucesso, chama `POST /api/v1/users/activate-invite` (sem corpo —
//      o backend identifica o convite pela sessão/token atual).
//   3. 404/409 do backend = convite inválido/expirado — mensagem clara,
//      orientando a solicitar um novo convite ao administrador.
// =============================================================================

type Phase = "checking" | "confirm" | "ready" | "invalid" | "activated";

// Apresentação: indicador de etapas (reflete só a fase REAL), skeleton enquanto
// o link é validado, troca de fase com fade (FadeIn), erro com entrada
// discreta (AnimatedFormMessage, role="alert") e `<Button loading>`.
const ACTIVATION_STEPS = ["Validar convite", "Definir senha", "Conta ativada"];

const TOKEN_HASH_MAX_LENGTH = 512;

/** Valida só o FORMATO (type=invite, hash não vazio, tamanho e charset razoáveis). */
function isPlausibleTokenHash(value: string | null, type: string | null): value is string {
  return (
    type === "invite" &&
    !!value &&
    value.length <= TOKEN_HASH_MAX_LENGTH &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
}

type UrlIntent =
  | { kind: "token"; tokenHash: string }
  | { kind: "invalid" }
  | { kind: "legacy" };

/** Lê a URL uma única vez e já a limpa (token_hash e erros nunca ficam no histórico). */
function readAndCleanUrl(): UrlIntent {
  const url = new URL(window.location.href);
  const query = url.searchParams;
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));

  const hasToken = query.has("token_hash") || query.has("type");
  const hasHashError = hashParams.has("error") || hashParams.has("error_code");
  if (!hasToken && !hasHashError) return { kind: "legacy" };

  const tokenHash = query.get("token_hash");
  const type = query.get("type");
  window.history.replaceState(window.history.state, "", url.pathname);

  if (hasToken && isPlausibleTokenHash(tokenHash, type)) return { kind: "token", tokenHash };
  return { kind: "invalid" };
}

export default function AtivarContaPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [activatedRole, setActivatedRole] = useState<string | null>(null);

  const tokenHashRef = useRef<string | null>(null);
  const intentRef = useRef<UrlIntent["kind"] | null>(null);
  const verifyingRef = useRef(false);
  const focusRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Ler/limpar a URL só uma vez (StrictMode executa o efeito duas vezes).
    if (intentRef.current === null) {
      const intent = readAndCleanUrl();
      intentRef.current = intent.kind;
      if (intent.kind === "token") tokenHashRef.current = intent.tokenHash;
      if (intent.kind === "token") setPhase("confirm");
      else if (intent.kind === "invalid") setPhase("invalid");
    }
    if (intentRef.current !== "legacy") return;

    // Fluxo legado: o SDK processa #access_token / ?code na instanciação.
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

  // Foco no título da fase ao trocar de fase (não na carga inicial).
  useEffect(() => {
    if (phase !== "checking") focusRef.current?.focus();
  }, [phase]);

  async function handleConfirm() {
    const tokenHash = tokenHashRef.current;
    if (!tokenHash || verifyingRef.current) return;
    verifyingRef.current = true;
    setConfirming(true);
    tokenHashRef.current = null; // uso único: nunca reenvia o mesmo hash
    try {
      const { data, error: verifyError } = await getSupabaseClient().auth.verifyOtp({
        token_hash: tokenHash,
        type: "invite",
      });
      setPhase(verifyError || !data.session ? "invalid" : "ready");
    } catch {
      setPhase("invalid");
    } finally {
      verifyingRef.current = false;
      setConfirming(false);
    }
  }

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

  const stepIndex = phase === "checking" || phase === "confirm" ? 0 : phase === "ready" ? 1 : ACTIVATION_STEPS.length;

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

        {phase === "confirm" && (
          <FadeIn className="flex flex-col gap-4">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              Confirme a ativação
            </h2>
            <p className="text-body-sm text-warm-granite">
              Recebemos o seu convite para o SISPAT-AGU. Selecione “Continuar” para validá-lo e
              definir a sua senha.
            </p>
            <Button type="button" loading={confirming} onClick={handleConfirm} className="w-full">
              {confirming ? "Validando…" : "Continuar"}
            </Button>
          </FadeIn>
        )}

        {phase === "invalid" && (
          <FadeIn className="flex flex-col gap-3">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              Link de convite inválido
            </h2>
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
              <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
                Defina sua senha
              </h2>
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
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              Ativação concluída
            </h2>
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
