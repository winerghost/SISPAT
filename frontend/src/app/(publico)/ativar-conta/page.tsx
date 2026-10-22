"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { FadeIn, SlideIn } from "@/components/animations";
import { AnimatedFormMessage, AuthField, StepIndicator } from "@/components/features/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "@/components/ui/form-message";
import { Skeleton } from "@/components/ui/skeleton";
import { getSupabaseClient } from "@/lib/supabase-client";
import { activateInvite, ApiError } from "@/lib/users-api";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AUTH_FAILURE_MESSAGES,
  classifyAuthError,
  logAuthFailure,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "./activation-errors";

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
//      `#access_token=...&type=invite` (implícito), troca por sessão e limpa a
//      URL. A página só ADOTA a sessão cujo access_token é IDÊNTICO ao do hash
//      lido na carga: uma sessão preexistente (de outra pessoa/aba) nunca é
//      aceita para definir senha. Sem `access_token` no hash, ou sem sessão
//      correspondente -> "invalid". O token fica só em ref (memória), nunca logado.
//
//   Também: `#error=access_denied&error_code=otp_expired` (hash) -> "invalid"
//   com a mensagem "link já usado ou expirado". A rota "/" repassa
//   `?token_hash=&type=invite|recovery` para cá (ver `auth-guard.tsx`).
//
//   MFA: se a sessão criada está em aal1 mas o usuário tem TOTP (nextLevel =
//   aal2), a fase "mfa" pede o código (`mfa.challengeAndVerify`, como o login)
//   ANTES do formulário de senha; `insufficient_aal` no `updateUser` leva à
//   mesma fase e repete o envio. Nada do código/segredo é armazenado.
//
//   Erros do Supabase viram mensagens fixas em `activation-errors.ts`
//   (nunca a mensagem crua); no console só `code`/`status`.
//
// Fluxo após a sessão existir:
//   1. Usuário define a senha (`supabase.auth.updateUser({ password })`).
//   2. CONVITE: em sucesso, chama `POST /api/v1/users/activate-invite` (sem
//      corpo — o backend identifica o convite pela sessão/token atual).
//      404/409 do backend = convite inválido/expirado — mensagem clara.
//
// RECUPERAÇÃO DE SENHA (o e-mail "Reset Password" também aponta para cá; não
// há página própria de reset). O modo vem do `type` do link:
//   - `?token_hash=...&type=recovery` (template recomendado; mesmo cuidado
//     anti-scanner do convite) -> `verifyOtp({ token_hash, type: "recovery" })`;
//   - legado `{{ .ConfirmationURL }}` -> `#access_token=...&type=recovery` ou
//     evento `PASSWORD_RECOVERY` do SDK.
//   Depois do `updateUser({ password })` NÃO chama activate-invite (usuário já
//   ativo: daria 404). Encerra a sessão local de recuperação (o próximo acesso
//   passa pelo login e pelo MFA), mostra sucesso e leva ao /login.
// =============================================================================

type Phase = "checking" | "confirm" | "mfa" | "ready" | "invalid" | "activated";
type InvalidReason = "invalid" | "expired";
type Mode = "invite" | "recovery";

/** Após redefinir a senha, segue sozinho para o login (o botão permite ir antes). */
const RECOVERY_REDIRECT_MS = 4000;
const RECOVERY_STEPS = ["Validar link", "Nova senha", "Senha redefinida"];
const RECOVERY_ERROR = "Não foi possível redefinir a senha agora. Abra o link de recuperação novamente.";

// Apresentação: indicador de etapas (reflete só a fase REAL), skeleton enquanto
// o link é validado, troca de fase com fade (FadeIn), erro com entrada
// discreta (AnimatedFormMessage, role="alert") e `<Button loading>`.
const ACTIVATION_STEPS = ["Validar convite", "Definir senha", "Conta ativada"];

const TOKEN_HASH_MAX_LENGTH = 512;

function isMode(type: string | null): type is Mode {
  return type === "invite" || type === "recovery";
}

/** Valida só o FORMATO (type=invite|recovery, hash não vazio, tamanho e charset razoáveis). */
function isPlausibleTokenHash(value: string | null, type: string | null): value is string {
  return (
    isMode(type) &&
    !!value &&
    value.length <= TOKEN_HASH_MAX_LENGTH &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
}

type UrlIntent =
  | { kind: "token"; tokenHash: string; mode: Mode }
  | { kind: "invalid"; mode: Mode; reason: InvalidReason }
  | { kind: "legacy"; mode: Mode; accessToken: string | null };

/** Lê a URL uma única vez e já a limpa (token_hash e erros nunca ficam no histórico). */
function readAndCleanUrl(): UrlIntent {
  const url = new URL(window.location.href);
  const query = url.searchParams;
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));

  const hasToken = query.has("token_hash") || query.has("type");
  const hasHashError = hashParams.has("error") || hashParams.has("error_code");
  // Legado: o SDK lê/limpa o hash; aqui só se lê o `type` e o access_token (para
  // adotar SOMENTE a sessão criada por este link, nunca uma preexistente).
  if (!hasToken && !hasHashError) {
    return {
      kind: "legacy",
      mode: hashParams.get("type") === "recovery" ? "recovery" : "invite",
      accessToken: hashParams.get("access_token") || null,
    };
  }

  const tokenHash = query.get("token_hash");
  const type = query.get("type");
  window.history.replaceState(window.history.state, "", url.pathname);

  const mode: Mode = type === "recovery" ? "recovery" : "invite";
  if (hasToken && isPlausibleTokenHash(tokenHash, type)) return { kind: "token", tokenHash, mode };
  const expired = hashParams.get("error_code") === "otp_expired";
  return { kind: "invalid", mode, reason: expired ? "expired" : "invalid" };
}

type NextStep = { phase: "ready" } | { phase: "mfa"; factorId: string };

/** Primeiro fator TOTP verificado do usuário da sessão atual (ou null). */
async function findTotpFactorId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    return error ? null : (data?.totp?.[0]?.id ?? null);
  } catch {
    return null;
  }
}

/**
 * Padrão do login: sessão aal1 com TOTP cadastrado (nextLevel aal2) exige o
 * código antes de qualquer troca de senha. Falha na consulta -> segue para o
 * formulário (o `updateUser` responde `insufficient_aal` se for o caso).
 */
async function nextStepAfterSession(supabase: SupabaseClient): Promise<NextStep> {
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.currentLevel === "aal1" && data.nextLevel === "aal2") {
      const factorId = await findTotpFactorId(supabase);
      if (factorId) return { phase: "mfa", factorId };
    }
  } catch {
    /* segue para o formulário */
  }
  return { phase: "ready" };
}

export default function AtivarContaPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [invalidReason, setInvalidReason] = useState<InvalidReason>("invalid");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [activatedRole, setActivatedRole] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("invite");
  // Passo TOTP (só memória; o código nunca é guardado além do input).
  const [factorId, setFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [retryAfterMfa, setRetryAfterMfa] = useState(false);
  const modeRef = useRef<Mode>("invite");
  const router = useRouter();

  const tokenHashRef = useRef<string | null>(null);
  const legacyTokenRef = useRef<string | null>(null);
  const adoptedRef = useRef(false);
  const intentRef = useRef<UrlIntent["kind"] | null>(null);
  const verifyingRef = useRef(false);
  const focusRef = useRef<HTMLHeadingElement>(null);

  function applyNextStep(step: NextStep) {
    if (step.phase === "mfa") {
      setFactorId(step.factorId);
      setMfaCode("");
      setMfaError(null);
    }
    setPhase(step.phase);
  }

  useEffect(() => {
    // Ler/limpar a URL só uma vez (StrictMode executa o efeito duas vezes).
    if (intentRef.current === null) {
      const intent = readAndCleanUrl();
      intentRef.current = intent.kind;
      modeRef.current = intent.mode;
      setMode(intent.mode);
      if (intent.kind === "token") tokenHashRef.current = intent.tokenHash;
      if (intent.kind === "legacy") legacyTokenRef.current = intent.accessToken;
      if (intent.kind === "token") setPhase("confirm");
      else if (intent.kind === "invalid") {
        setInvalidReason(intent.reason);
        setPhase("invalid");
      } else if (!intent.accessToken) {
        // Sem credencial na URL: NUNCA aceitar sessão preexistente (de outra pessoa).
        setPhase("invalid");
      }
    }
    if (intentRef.current !== "legacy" || !legacyTokenRef.current) return;

    // Fluxo legado: o SDK processa #access_token na instanciação. Só se adota a
    // sessão cujo access_token é o MESMO do link (uma vez).
    let active = true;
    const supabase = getSupabaseClient();
    const adopt = (accessToken: string | undefined) => {
      if (!active || adoptedRef.current || !accessToken) return;
      if (accessToken !== legacyTokenRef.current) return;
      adoptedRef.current = true;
      void nextStepAfterSession(supabase).then((step) => {
        if (active) applyNextStep(step);
      });
    };
    supabase.auth.getSession().then(({ data }) => {
      if (!active || adoptedRef.current) return;
      adopt(data.session?.access_token);
      // Sem sessão correspondente ao link (inválido/expirado): nada é aceito.
      if (!adoptedRef.current) setPhase((current) => (current === "checking" ? "invalid" : current));
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") {
        modeRef.current = "recovery";
        setMode("recovery");
      }
      adopt(session?.access_token);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executa uma vez; só usa refs e setters estáveis
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
      const supabase = getSupabaseClient();
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: modeRef.current,
      });
      if (verifyError || !data.session) {
        const failure = classifyAuthError(verifyError);
        logAuthFailure(failure, "validar link");
        setInvalidReason(failure.kind === "expired" ? "expired" : "invalid");
        setPhase("invalid");
        return;
      }
      applyNextStep(await nextStepAfterSession(supabase));
    } catch {
      setPhase("invalid");
    } finally {
      verifyingRef.current = false;
      setConfirming(false);
    }
  }

  /** Troca a senha no Supabase (e, no convite, ativa no backend). */
  async function applyPassword() {
    setSubmitting(true);
    try {
      const supabase = getSupabaseClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        const failure = classifyAuthError(updateError);
        logAuthFailure(failure, "definir senha");
        if (failure.kind === "mfa_required") {
          const id = await findTotpFactorId(supabase);
          if (id) {
            setFactorId(id);
            setMfaCode("");
            setMfaError(null);
            setRetryAfterMfa(true);
            setPhase("mfa");
            return;
          }
          setError(AUTH_FAILURE_MESSAGES.generic);
          return;
        }
        if (failure.kind === "expired") {
          setInvalidReason("expired");
          setPhase("invalid");
          return;
        }
        setError(failure.message);
        return;
      }

      if (modeRef.current === "recovery") {
        // Usuário já ativo: nada de activate-invite. Encerra a sessão de
        // recuperação para o próximo acesso passar pelo login (e MFA).
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        setPhase("activated");
        return;
      }

      const result = await activateInvite();
      setActivatedRole(result.role);
      setPhase("activated");
    } catch (cause) {
      setError(modeRef.current === "recovery" ? RECOVERY_ERROR : activateErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_TOO_SHORT_MESSAGE);
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }
    await applyPassword();
  }

  async function handleMfaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!factorId || mfaVerifying) return;
    setMfaError(null);
    setMfaVerifying(true);
    try {
      const { error: verifyError } = await getSupabaseClient().auth.mfa.challengeAndVerify({
        factorId,
        code: mfaCode,
      });
      if (verifyError) {
        logAuthFailure(classifyAuthError(verifyError), "verificar código TOTP");
        setMfaError("Código inválido ou expirado. Tente novamente.");
        setMfaCode("");
        return;
      }
      setMfaCode("");
      setFactorId(null);
      setPhase("ready");
      if (retryAfterMfa) {
        // A troca de senha havia sido barrada por AAL: repete agora em aal2.
        setRetryAfterMfa(false);
        setError(null);
        await applyPassword();
      }
    } catch {
      setMfaError("Não foi possível verificar o código agora. Tente novamente.");
    } finally {
      setMfaVerifying(false);
    }
  }

  const recovery = mode === "recovery";
  const steps = recovery ? RECOVERY_STEPS : ACTIVATION_STEPS;
  const stepIndex = phase === "checking" || phase === "confirm" || phase === "mfa" ? 0 : phase === "ready" ? 1 : steps.length;

  // Recuperação concluída: segue para o login (o botão permite ir antes).
  useEffect(() => {
    if (phase !== "activated" || !recovery) return;
    const handle = setTimeout(() => router.replace("/login"), RECOVERY_REDIRECT_MS);
    return () => clearTimeout(handle);
  }, [phase, recovery, router]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4 sm:p-8">
      <SlideIn
        distance="sm"
        className="flex w-full max-w-sm flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-heading text-[28px] text-bone">{recovery ? "Redefinir senha" : "Ativar conta"}</h1>
        </div>

        {phase !== "invalid" && (
          <StepIndicator
            label={recovery ? "Etapas da redefinição de senha" : "Etapas da ativação"}
            steps={steps}
            current={stepIndex}
          />
        )}

        {phase === "checking" && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <p role="status" className="text-body-sm text-warm-granite">
              {recovery ? "Validando seu link de recuperação…" : "Validando seu link de convite…"}
            </p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {phase === "confirm" && (
          <FadeIn className="flex flex-col gap-4">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              {recovery ? "Confirme a redefinição" : "Confirme a ativação"}
            </h2>
            <p className="text-body-sm text-warm-granite">
              {recovery
                ? "Recebemos o pedido de redefinição da sua senha do SISPAT-AGU. Selecione “Continuar” para validar o link e definir a nova senha."
                : "Recebemos o seu convite para o SISPAT-AGU. Selecione “Continuar” para validá-lo e definir a sua senha."}
            </p>
            <Button type="button" loading={confirming} onClick={handleConfirm} className="w-full">
              {confirming ? "Validando…" : "Continuar"}
            </Button>
          </FadeIn>
        )}

        {phase === "invalid" && (
          <FadeIn className="flex flex-col gap-3">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              {recovery ? "Link de recuperação inválido" : "Link de convite inválido"}
            </h2>
            <FormMessage>
              {invalidReason === "expired"
                ? recovery
                  ? "Este link de recuperação já foi usado ou expirou. Peça uma nova redefinição de senha a um administrador."
                  : "Este link de convite já foi usado ou expirou. Peça um novo convite a um administrador."
                : recovery
                  ? "Este link de recuperação é inválido ou já expirou. Solicite uma nova redefinição de senha a um administrador."
                  : "Este link de convite é inválido ou já expirou. Solicite um novo convite a um administrador."}
            </FormMessage>
            <Link
              href="/login"
              className="inline-flex min-h-6 items-center self-start text-body-sm text-bone underline underline-offset-4"
            >
              Ir para o login
            </Link>
          </FadeIn>
        )}

        {phase === "mfa" && (
          <FadeIn>
            <form className="flex flex-col gap-4" onSubmit={handleMfaSubmit}>
              <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
                Confirme a verificação em duas etapas
              </h2>
              <p className="text-body-sm text-warm-granite">
                Sua conta usa verificação em duas etapas. Informe o código do seu aplicativo autenticador para
                {recovery ? " definir a nova senha." : " definir a senha."}
              </p>
              <AuthField label="Código de verificação">
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={10}
                  required
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  disabled={mfaVerifying}
                  aria-invalid={mfaError ? true : undefined}
                  aria-describedby={mfaError ? "ativar-mfa-erro" : undefined}
                />
              </AuthField>
              <AnimatedFormMessage id="ativar-mfa-erro" message={mfaError} />
              <Button type="submit" loading={mfaVerifying} disabled={mfaCode.length === 0} className="w-full">
                {mfaVerifying ? "Verificando…" : "Verificar"}
              </Button>
            </form>
          </FadeIn>
        )}

        {phase === "ready" && (
          <FadeIn>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
                {recovery ? "Defina a nova senha" : "Defina sua senha"}
              </h2>
              <p className="text-body-sm text-warm-granite">
                {recovery
                  ? `Defina a nova senha (mínimo de ${MIN_PASSWORD_LENGTH} caracteres). A senha anterior deixa de valer.`
                  : `Defina uma senha (mínimo de ${MIN_PASSWORD_LENGTH} caracteres) para concluir a ativação da sua conta.`}
              </p>

              <AuthField label="Nova senha">
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
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
                  minLength={MIN_PASSWORD_LENGTH}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "ativar-erro" : undefined}
                />
              </AuthField>

              <AnimatedFormMessage id="ativar-erro" message={error} />

              <Button type="submit" loading={submitting} className="w-full">
                {recovery ? (submitting ? "Salvando…" : "Redefinir senha") : submitting ? "Ativando…" : "Ativar conta"}
              </Button>
            </form>
          </FadeIn>
        )}

        {/* Recuperação: sucesso só depois de o Supabase confirmar a nova senha. */}
        {phase === "activated" && recovery && (
          <FadeIn className="flex flex-col gap-3" data-recovery-done>
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              Senha redefinida
            </h2>
            <p role="status" className="flex items-start gap-2 text-body-sm text-metric-green">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                Senha redefinida com sucesso. Entre com seu e-mail e a nova senha; você será levado ao login
                em instantes.
              </span>
            </p>
            <Button asChild className="w-full">
              <Link href="/login">Ir para o login</Link>
            </Button>
          </FadeIn>
        )}

        {/* Sucesso: só após a resposta real do backend (phase "activated"). */}
        {phase === "activated" && !recovery && (
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
