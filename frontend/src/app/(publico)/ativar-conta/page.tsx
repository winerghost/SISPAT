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
import {
  isKnownActivationMode,
  parseActivationLink,
  type ActivationFailure,
  type ActivationIntent,
  type ActivationMode,
} from "@/lib/activation-link";
import { getRecoveryAccessToken } from "@/lib/recovery-session";
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
// /ativar-conta — destino dos links de convite E de recuperação de senha
// =============================================================================
// A leitura do link é PURA e fica em `@/lib/activation-link` (a mesma usada
// pela rede de segurança da raiz). Quatro formatos chegam aqui:
//
//   1) token_hash (fluxo ATUAL; desde 2026-10-28 o backend monta o link):
//      `/ativar-conta?token_hash=<hash>&type=invite|recovery`.
//      Scanners de antivírus de e-mail fazem GET automático em todo link e
//      consumiriam um link de uso único, por isso esta página NÃO consome nada
//      ao carregar: lê a credencial, LIMPA a URL (history.replaceState), guarda
//      o valor só em memória (ref; nunca localStorage/sessionStorage, nunca
//      logado) e mostra a fase "confirm". Só o clique em "Continuar" chama
//      `verifyOtp({ token_hash, type })`. ESSA PROPRIEDADE É A CORREÇÃO DO
//      INCIDENTE DE 2026-10-27 — não remover.
//
//   2) PKCE: `?code=<code>` (o `type` normalmente não vem). O cliente do
//      navegador é implícito (sem `flowType`), então o SDK não processa `?code=`
//      sozinho e antes desta correção um link VÁLIDO aparecia como inválido
//      (F2). Agora o `code` é tratado igual ao token_hash: guardado em memória e
//      trocado por sessão (`exchangeCodeForSession`) só no clique.
//
//   3) Legado implícito (`#access_token=...&type=...`): o SDK
//      (`detectSessionInUrl: true`) troca o hash por sessão ao ser instanciado.
//      A página só ADOTA a sessão cujo access_token é IDÊNTICO ao do hash lido
//      na carga — uma sessão preexistente (de outra pessoa/aba) nunca é aceita
//      para definir senha. Exceção controlada: quando a pessoa chega da raiz,
//      vale também o access_token da sessão que o SDK anunciou como
//      `PASSWORD_RECOVERY` nesta mesma carga (`recovery-session.ts`, F6).
//
//   4) Erro do provedor, na QUERY ou no hash (`error`, `error_code`,
//      `error_description`): vai para a fase "invalid" com a mensagem da causa.
//      Antes só o hash era lido: erro de recovery na query string aparecia com
//      texto de "convite" e o `error_description` ficava na URL e no histórico
//      (F1).
//
// Sem `type` reconhecível o modo é "unknown" e os textos ficam NEUTROS — a tela
// nunca afirma que é convite sem saber (F3).
//
// Erros do Supabase viram mensagens fixas em `activation-errors.ts` (nunca a
// mensagem crua); no console só `code`/`status`. Falha de REDE não descarta a
// credencial: a pessoa pode clicar de novo (F5).
//
// MFA: se a sessão criada está em aal1 mas o usuário tem TOTP (nextLevel =
// aal2), a fase "mfa" pede o código (`mfa.challengeAndVerify`, como o login)
// ANTES do formulário de senha; `insufficient_aal` no `updateUser` leva à mesma
// fase e repete o envio. Nada do código/segredo é armazenado.
//
// Fluxo após a sessão existir:
//   1. Usuário define a senha (`supabase.auth.updateUser({ password })`).
//   2. CONVITE: em sucesso, chama `POST /api/v1/users/activate-invite` (sem
//      corpo — o backend identifica o convite pela sessão/token atual).
//      404/409 do backend = convite inválido/expirado — mensagem clara.
//   3. RECUPERAÇÃO: NÃO chama activate-invite (usuário já ativo: daria 404).
//      Encerra a sessão local de recuperação (o próximo acesso passa pelo login
//      e pelo MFA), mostra sucesso e leva ao /login.
//   4. MODO INDETERMINADO: tenta a ativação; se o backend disser que não há
//      convite (404/409), a senha já foi trocada — trata como redefinição.
// =============================================================================

type Phase = "checking" | "confirm" | "mfa" | "ready" | "invalid" | "activated";
type InvalidReason = ActivationFailure;
type Mode = ActivationMode;

/** Após redefinir a senha, segue sozinho para o login (o botão permite ir antes). */
const RECOVERY_REDIRECT_MS = 4000;
const RECOVERY_ERROR = "Não foi possível redefinir a senha agora. Abra o link de recuperação novamente.";

// ---------------------------------------------------------------------------
// Textos por MODO (convite / recuperação / indeterminado) — nunca afirmam o que
// o link não disse. Apresentação: indicador de etapas (reflete só a fase REAL),
// skeleton enquanto o link é validado, troca de fase com fade (FadeIn), erro com
// entrada discreta (AnimatedFormMessage, role="alert") e `<Button loading>`.
// ---------------------------------------------------------------------------

interface ModeCopy {
  title: string;
  steps: [string, string, string];
  stepsLabel: string;
  checking: string;
  confirmTitle: string;
  confirmText: string;
  invalidTitle: string;
  /** Sujeito da frase de link inválido ("Este link de convite", ...). */
  subject: string;
  /** Como pedir um novo link. */
  request: string;
  passwordTitle: string;
  passwordHint: string;
  submit: string;
  submitting: string;
  doneTitle: string;
}

const MODE_COPY: Record<Mode, ModeCopy> = {
  invite: {
    title: "Ativar conta",
    steps: ["Validar convite", "Definir senha", "Conta ativada"],
    stepsLabel: "Etapas da ativação",
    checking: "Validando seu link de convite…",
    confirmTitle: "Confirme a ativação",
    confirmText:
      "Recebemos o seu convite para o SISPAT-AGU. Selecione “Continuar” para validá-lo e definir a sua senha.",
    invalidTitle: "Link de convite inválido",
    subject: "Este link de convite",
    request: "Peça um novo convite a um administrador.",
    passwordTitle: "Defina sua senha",
    passwordHint: `Defina uma senha (mínimo de ${MIN_PASSWORD_LENGTH} caracteres) para concluir a ativação da sua conta.`,
    submit: "Ativar conta",
    submitting: "Ativando…",
    doneTitle: "Ativação concluída",
  },
  recovery: {
    title: "Redefinir senha",
    steps: ["Validar link", "Nova senha", "Senha redefinida"],
    stepsLabel: "Etapas da redefinição de senha",
    checking: "Validando seu link de recuperação…",
    confirmTitle: "Confirme a redefinição",
    confirmText:
      "Recebemos o pedido de redefinição da sua senha do SISPAT-AGU. Selecione “Continuar” para validar o link e definir a nova senha.",
    invalidTitle: "Link de recuperação inválido",
    subject: "Este link de recuperação",
    request: "Peça uma nova redefinição de senha a um administrador.",
    passwordTitle: "Defina a nova senha",
    passwordHint: `Defina a nova senha (mínimo de ${MIN_PASSWORD_LENGTH} caracteres). A senha anterior deixa de valer.`,
    submit: "Redefinir senha",
    submitting: "Salvando…",
    doneTitle: "Senha redefinida",
  },
  unknown: {
    title: "Acesso por link",
    steps: ["Validar link", "Definir senha", "Concluído"],
    stepsLabel: "Etapas da validação do link",
    checking: "Validando seu link…",
    confirmTitle: "Confirme a validação do link",
    confirmText:
      "Recebemos um link de acesso ao SISPAT-AGU. Selecione “Continuar” para validá-lo e definir a sua senha.",
    invalidTitle: "Link inválido",
    subject: "Este link",
    request: "Peça um novo link a um administrador.",
    passwordTitle: "Defina sua senha",
    passwordHint: `Defina uma senha (mínimo de ${MIN_PASSWORD_LENGTH} caracteres) para concluir.`,
    submit: "Definir senha",
    submitting: "Salvando…",
    doneTitle: "Senha definida",
  },
};

const REASON_CORE: Record<"expired" | "invalid", string> = {
  expired: "já foi usado ou expirou.",
  invalid: "é inválido ou já expirou.",
};

/** Mensagem da fase "invalid": causa (F4) + modo (F3), sem detalhe do provedor. */
function invalidMessage(mode: Mode, reason: InvalidReason): string {
  const copy = MODE_COPY[mode];
  if (reason === "rate_limited") {
    return "Houve muitas tentativas com este link. Aguarde alguns minutos e abra o link do e-mail novamente.";
  }
  if (reason === "session") {
    return "A validação deste link não está mais ativa. Abra o link do e-mail novamente.";
  }
  return `${copy.subject} ${REASON_CORE[reason]} ${copy.request}`;
}

/** Causa (classificação do erro do Supabase) → motivo exibido na fase "invalid". */
function reasonFromFailure(kind: string): InvalidReason {
  if (kind === "expired") return "expired";
  if (kind === "rate_limited") return "rate_limited";
  if (kind === "session_lost") return "session";
  return "invalid";
}

/** `redirectType` só existe na resposta do PKCE; lido de forma defensiva. */
function readRedirectType(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("redirectType" in data)) return null;
  const value = (data as { redirectType?: unknown }).redirectType;
  return typeof value === "string" ? value : null;
}

type UrlIntent = ActivationIntent | { kind: "none"; mode: Mode };

/**
 * Lê a URL uma única vez e já a limpa (credenciais e erros nunca ficam na URL
 * nem no histórico). O hash do fluxo LEGADO é a exceção: quem o consome é o
 * SDK, então ele é preservado — o próprio SDK o remove depois.
 */
function readAndCleanUrl(): UrlIntent {
  const url = new URL(window.location.href);
  const intent = parseActivationLink(url.search, url.hash);

  if (intent && intent.kind !== "legacy") {
    window.history.replaceState(window.history.state, "", url.pathname);
    return intent;
  }
  if (intent) return intent;

  // Sem nada na URL: só vale a sessão que o SDK anunciou como PASSWORD_RECOVERY
  // nesta carga (chegada pela raiz, F6). Sessão preexistente nunca é aceita.
  const recoveryToken = getRecoveryAccessToken();
  if (recoveryToken) return { kind: "legacy", accessToken: recoveryToken, mode: "recovery" };
  return { kind: "none", mode: "unknown" };
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
  const [mode, setMode] = useState<Mode>("unknown");
  // Passo TOTP (só memória; o código nunca é guardado além do input).
  const [factorId, setFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [retryAfterMfa, setRetryAfterMfa] = useState(false);
  const modeRef = useRef<Mode>("unknown");
  const router = useRouter();

  // Credenciais de uso único: só em memória, nunca em storage, nunca logadas.
  const tokenHashRef = useRef<string | null>(null);
  const codeRef = useRef<string | null>(null);
  const legacyTokenRef = useRef<string | null>(null);
  const adoptedRef = useRef(false);
  const intentRef = useRef<UrlIntent["kind"] | null>(null);
  const verifyingRef = useRef(false);
  const focusRef = useRef<HTMLHeadingElement>(null);

  function applyMode(next: Mode) {
    modeRef.current = next;
    setMode(next);
  }

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
      if (intent.kind === "token") {
        tokenHashRef.current = intent.tokenHash;
        setPhase("confirm");
      } else if (intent.kind === "code") {
        codeRef.current = intent.code;
        setPhase("confirm");
      } else if (intent.kind === "error") {
        setInvalidReason(intent.failure);
        setPhase("invalid");
      } else if (intent.kind === "legacy") {
        legacyTokenRef.current = intent.accessToken;
      } else {
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
      // O token já virou sessão: tirar o hash da URL e do histórico (quando a
      // pessoa chegou pela raiz, o SDK não limpa de novo).
      if (window.location.hash) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
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
      if (event === "PASSWORD_RECOVERY") applyMode("recovery");
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

  /**
   * Valida o link no clique da pessoa (nunca na carga): `verifyOtp` para
   * `token_hash`, `exchangeCodeForSession` para `?code=`.
   *
   * F5: a credencial só é descartada quando o servidor dá uma resposta
   * DEFINITIVA. Falha de rede/5xx e limite de tentativas preservam o valor em
   * memória para uma nova tentativa — antes, qualquer falha zerava o token e a
   * pessoa via "expirado" sem chance de tentar de novo.
   */
  async function handleConfirm() {
    const tokenHash = tokenHashRef.current;
    const code = codeRef.current;
    // `verifyOtp` exige um `type` conhecido; `?code=` costuma vir sem `type`.
    const knownMode = isKnownActivationMode(modeRef.current) ? modeRef.current : null;
    const useToken = tokenHash !== null && knownMode !== null;
    if ((!useToken && code === null) || verifyingRef.current) return;
    verifyingRef.current = true;
    setConfirming(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const result =
        useToken && tokenHash && knownMode
          ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: knownMode })
          : await supabase.auth.exchangeCodeForSession(code ?? "");
      const { data, error: verifyError } = result;
      if (verifyError || !data.session) {
        const failure = classifyAuthError(verifyError);
        logAuthFailure(failure, "validar link");
        if (failure.kind === "network" || failure.kind === "rate_limited") {
          setError(failure.message); // credencial preservada: dá para tentar de novo
          return;
        }
        tokenHashRef.current = null; // resposta definitiva: uso único
        codeRef.current = null;
        setInvalidReason(reasonFromFailure(failure.kind));
        setPhase("invalid");
        return;
      }
      tokenHashRef.current = null;
      codeRef.current = null;
      // PKCE sem `type` na URL: o SDK informa se o link era de recuperação.
      if (readRedirectType(data) === "recovery") applyMode("recovery");
      applyNextStep(await nextStepAfterSession(supabase));
    } catch (cause) {
      // Exceção (rede/SDK): a credencial continua em memória (F5).
      logAuthFailure(classifyAuthError(cause), "validar link");
      setError(AUTH_FAILURE_MESSAGES.network);
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
        // Link/sessão sem volta: sai do formulário com a causa certa (F4).
        if (failure.kind === "expired" || failure.kind === "link_invalid" || failure.kind === "session_lost") {
          setInvalidReason(reasonFromFailure(failure.kind));
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

      try {
        const result = await activateInvite();
        setActivatedRole(result.role);
      } catch (cause) {
        // Modo indeterminado (link sem `type`): se não havia convite, a senha
        // já foi trocada — trata como redefinição, sem erro falso.
        if (modeRef.current !== "unknown" || !isInviteGone(cause)) throw cause;
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      }
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

  const copy = MODE_COPY[mode];
  const recovery = mode === "recovery";
  const steps = copy.steps;
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
          <h1 className="text-heading text-[28px] text-bone">{copy.title}</h1>
        </div>

        {phase !== "invalid" && (
          <StepIndicator label={copy.stepsLabel} steps={steps} current={stepIndex} />
        )}

        {phase === "checking" && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <p role="status" className="text-body-sm text-warm-granite">
              {copy.checking}
            </p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {phase === "confirm" && (
          <FadeIn className="flex flex-col gap-4">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              {copy.confirmTitle}
            </h2>
            <p className="text-body-sm text-warm-granite">{copy.confirmText}</p>
            {/* Falha de rede/limite: o link continua válido (F5). */}
            <AnimatedFormMessage id="ativar-erro" message={error} />
            <Button type="button" loading={confirming} onClick={handleConfirm} className="w-full">
              {confirming ? "Validando…" : "Continuar"}
            </Button>
          </FadeIn>
        )}

        {phase === "invalid" && (
          <FadeIn className="flex flex-col gap-3">
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              {copy.invalidTitle}
            </h2>
            <FormMessage>{invalidMessage(mode, invalidReason)}</FormMessage>
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
                {copy.passwordTitle}
              </h2>
              <p className="text-body-sm text-warm-granite">{copy.passwordHint}</p>

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
                {submitting ? copy.submitting : copy.submit}
              </Button>
            </form>
          </FadeIn>
        )}

        {/* Sucesso: só depois de o Supabase (e, no convite, o backend) confirmar. */}
        {phase === "activated" && (
          <FadeIn className="flex flex-col gap-3" {...(recovery ? { "data-recovery-done": true } : {})}>
            <h2 ref={focusRef} tabIndex={-1} className="text-body text-bone focus:outline-none">
              {copy.doneTitle}
            </h2>
            <p role="status" className="flex items-start gap-2 text-body-sm text-metric-green">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {recovery ? (
                  <>
                    Senha redefinida com sucesso. Entre com seu e-mail e a nova senha; você será levado ao login
                    em instantes.
                  </>
                ) : mode === "invite" ? (
                  <>
                    Conta ativada com sucesso{activatedRole ? ` como ${activatedRole}` : ""}. Você já pode entrar
                    com seu e-mail e a nova senha.
                  </>
                ) : (
                  <>Senha definida com sucesso. Você já pode entrar com seu e-mail e a nova senha.</>
                )}
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

/** 404/409 do backend = não havia convite pendente para esta sessão. */
function isInviteGone(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 409);
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
