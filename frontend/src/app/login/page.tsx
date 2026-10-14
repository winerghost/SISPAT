"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { FadeIn, SlideIn } from "@/components/animations";
import { AguLogo } from "@/components/brand/agu-logo";
import { AnimatedFormMessage, AuthField, AuthGuidancePanel } from "@/components/features/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchMe } from "@/lib/session";
import { getSupabaseClient } from "@/lib/supabase-client";

// =============================================================================
// /login — SISPAT-AGU
// =============================================================================
// Fluxo:
//   1. E-mail + senha → `supabase.auth.signInWithPassword()`.
//   2. Em sucesso, chama `GET /api/v1/me`.
//   3. Se `mfa_required && current_aal !== 'aal2'` → etapa de desafio MFA:
//      lista os fatores (`supabase.auth.mfa.listFactors()`), seleciona o
//      fator TOTP verificado, pede o código e chama
//      `supabase.auth.mfa.challengeAndVerify({ factorId, code })`.
//   4. Após verificar, re-chama `/me` para confirmar `current_aal === 'aal2'`
//      antes de liberar a navegação — só então redireciona.
//
// Sem rota de cadastro: este sistema não tem autorregistro — contas só
// existem por convite ADM (`/administracao/usuarios` → `/ativar-conta`).
//
// Mensagens de erro são sempre genéricas (sem detalhe técnico), tanto para
// credenciais inválidas quanto para limite de tentativas (status 429 do
// Supabase Auth), conforme exigido pela tarefa.
//
// Apresentação (sem alterar o fluxo acima): formulário com entrada suave
// (SlideIn — a 1ª carga SSR não anima, por design da fundação); troca
// senha → MFA com fade (FadeIn com `key`, sem esperar saída: o campo do código
// existe no mesmo commit e recebe o foco); erros com AnimatedFormMessage
// (role="alert" mantido); `<Button loading>`; após a confirmação real, um
// status "Acesso confirmado" aparece enquanto o `router.push` já está em
// curso (não atrasa o redirect). >= lg: painel lateral de orientações
// (AuthGuidancePanel/InfoSlider), DEPOIS do formulário na ordem do DOM.
// =============================================================================

type Step = "credentials" | "mfa";

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("credentials");
  // WCAG 2.4.3: ao trocar para a etapa MFA o botão "Entrar" (que tinha o
  // foco) deixa de existir; o foco vai explicitamente para o campo do código
  // (`autoFocus` sozinho não era aplicado de forma confiável aqui).
  const codeInputRef = useRef<HTMLInputElement>(null);
  // "Voltar" remove o botão focado; o foco volta ao campo de e-mail.
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [returnFocusToEmail, setReturnFocusToEmail] = useState(false);
  // Só apresentação: status exibido enquanto o redirect (já disparado) ocorre.
  const [redirecting, setRedirecting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step === "mfa" && !loading) codeInputRef.current?.focus();
  }, [step, loading]);

  useEffect(() => {
    if (step === "credentials" && returnFocusToEmail) {
      emailInputRef.current?.focus();
      setReturnFocusToEmail(false);
    }
  }, [step, returnFocusToEmail]);

  async function handleCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = getSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(credentialsErrorMessage(signInError));
        setLoading(false);
        return;
      }

      await proceedPastSignIn();
    } catch {
      setError("Não foi possível entrar agora. Tente novamente em alguns instantes.");
      setLoading(false);
    }
  }

  /** Decide, a partir de `/me`, se segue para o desafio MFA ou libera a navegação. */
  async function proceedPastSignIn() {
    let me;
    try {
      me = await fetchMe();
    } catch {
      setError("Não foi possível confirmar sua sessão agora. Tente novamente.");
      setLoading(false);
      return;
    }

    if (!me.mfa_required || me.current_aal === "aal2") {
      router.push("/");
      setRedirecting(true);
      return;
    }

    const supabase = getSupabaseClient();
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      setError("Não foi possível carregar a verificação em duas etapas. Tente novamente.");
      setLoading(false);
      return;
    }

    const totpFactor = factorsData.totp[0];
    if (!totpFactor) {
      setError(
        "Sua conta exige verificação em duas etapas, mas nenhum fator está configurado. Contate um administrador.",
      );
      setLoading(false);
      return;
    }

    setFactorId(totpFactor.id);
    setStep("mfa");
    setLoading(false);
  }

  async function handleMfaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!factorId) return;
    setError(null);
    setLoading(true);

    try {
      const supabase = getSupabaseClient();
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      });

      if (verifyError) {
        setError("Código inválido ou expirado. Tente novamente.");
        setCode("");
        setLoading(false);
        return;
      }

      // Re-confirma o AAL via backend antes de liberar a navegação para a
      // área administrativa (nunca confiar só no retorno do SDK Supabase).
      const me = await fetchMe();
      if (me.current_aal !== "aal2") {
        setError("Não foi possível confirmar a verificação em duas etapas. Tente novamente.");
        setLoading(false);
        return;
      }

      router.push("/");
      setRedirecting(true);
    } catch {
      setError("Não foi possível verificar o código agora. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-4 sm:p-8">
      <div className="grid w-full max-w-sm gap-10 lg:max-w-[56rem] lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-center xl:gap-14">
        <SlideIn
          distance="sm"
          className="flex w-full min-w-0 flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
        >
          <AguLogo />
          <FadeIn key={step} className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <span className="text-eyebrow text-pale-stone">SISPAT-AGU</span>
              <h1 className="text-heading text-[28px] text-bone">
                {step === "credentials" ? "Entrar" : "Verificação em duas etapas"}
              </h1>
              <p className="text-body-sm text-warm-granite">
                {step === "credentials"
                  ? "Acesse com seu e-mail institucional e senha."
                  : "Informe o código gerado pelo seu aplicativo autenticador."}
              </p>
            </div>

            {step === "credentials" ? (
              <form className="flex flex-col gap-4" onSubmit={handleCredentialsSubmit}>
                <AuthField label="E-mail">
                  <Input
                    ref={emailInputRef}
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "login-error" : undefined}
                  />
                </AuthField>
                <AuthField label="Senha">
                  <Input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "login-error" : undefined}
                  />
                </AuthField>

                <AnimatedFormMessage id="login-error" message={error} />

                <Button type="submit" loading={loading} className="w-full">
                  {loading ? "Entrando…" : "Entrar"}
                </Button>
              </form>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={handleMfaSubmit}>
                <AuthField label="Código de verificação">
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    maxLength={10}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={loading}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "login-error" : undefined}
                    ref={codeInputRef}
                  />
                </AuthField>

                <AnimatedFormMessage id="login-error" message={error} />

                <Button type="submit" loading={loading} disabled={code.length === 0} className="w-full">
                  {loading ? "Verificando…" : "Verificar"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading}
                  className="w-full"
                  onClick={() => {
                    // Segurança: abandonar o desafio MFA descarta a sessão AAL1
                    // parcial (não deixa sessão "meio autenticada" no navegador).
                    void getSupabaseClient().auth.signOut({ scope: "local" });
                    setStep("credentials");
                    setCode("");
                    setError(null);
                    setReturnFocusToEmail(true);
                  }}
                >
                  Voltar
                </Button>
              </form>
            )}
          </FadeIn>

          {/* Feedback pós-autenticação: o redirect já foi disparado. */}
          {redirecting && (
            <FadeIn>
              <p role="status" className="flex items-center gap-2 text-body-sm text-metric-green">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                Acesso confirmado. Redirecionando…
              </p>
            </FadeIn>
          )}
        </SlideIn>

        <AuthGuidancePanel />
      </div>
    </div>
  );
}

/** Mapeia erros do Supabase Auth para mensagens genéricas, sem detalhe técnico. */
function credentialsErrorMessage(error: { status?: number }): string {
  if (error.status === 429) {
    return "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.";
  }
  return "E-mail ou senha incorretos.";
}
