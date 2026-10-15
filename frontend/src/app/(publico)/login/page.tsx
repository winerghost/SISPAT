"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { FadeIn, SlideIn } from "@/components/animations";
import {
  AnimatedFormMessage,
  AuthField,
  AuthGuidancePanel,
  TotpEnrollDetails,
} from "@/components/features/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInErrorMessage, SIGN_IN_MESSAGES } from "@/lib/auth-errors";
import { discardUnverifiedFactor, startTotpEnrollment, type TotpEnrollment } from "@/lib/mfa";
import { fetchMe } from "@/lib/session";
import { getSupabaseClient } from "@/lib/supabase-client";
import { notifyMfaFactorAdded } from "@/lib/users-api";

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
//   3b. Se `mfa_required` mas NÃO há fator TOTP verificado (ADM único, bootstrap):
//      etapa "enroll" — `supabase.auth.mfa.enroll()` com a sessão AAL1 (QR +
//      chave manual + código de 6 dígitos → `challengeAndVerify`). Segredo/QR
//      ficam só em memória (estado React), são descartados ao concluir/voltar;
//      "Voltar" remove (unenroll) o fator pendente e encerra a sessão local.
//   4. Após verificar, re-chama `/me` para confirmar `current_aal === 'aal2'`
//      antes de liberar a navegação — só então redireciona.
//
// Sem rota de cadastro: este sistema não tem autorregistro — contas só
// existem por convite ADM (`/administracao/usuarios` → `/ativar-conta`).
//
// Mensagens de erro são sempre genéricas (sem detalhe técnico) e distinguem
// rede/servidor, limite de tentativas (429) e credencial (`@/lib/auth-errors`).
// Após cadastrar o 1º fator, `POST /security/mfa/factor-added-notice` é chamado
// em best-effort (falha ignorada).
//
// Apresentação (sem alterar o fluxo acima): formulário com entrada suave
// (SlideIn — a 1ª carga SSR não anima, por design da fundação); troca
// senha → MFA com fade (FadeIn com `key`, sem esperar saída: o campo do código
// existe no mesmo commit e recebe o foco); erros com AnimatedFormMessage
// (role="alert" mantido); `<Button loading>`; após a confirmação real, um
// status "Acesso confirmado" aparece enquanto o `router.push` já está em
// curso (não atrasa o redirect). Marca (AguLogo + eyebrow), rodapé e fundo
// vêm de (publico)/layout.tsx (tela autônoma, sem shell). >= lg: painel lateral de orientações
// (AuthGuidancePanel/InfoSlider), DEPOIS do formulário na ordem do DOM.
// =============================================================================

type Step = "credentials" | "mfa" | "enroll";

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
  // Segredo TOTP/QR do cadastro do 1º fator: SÓ memória do componente.
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if ((step === "mfa" || step === "enroll") && !loading) codeInputRef.current?.focus();
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
        setError(signInErrorMessage(signInError));
        setLoading(false);
        return;
      }

      await proceedPastSignIn();
    } catch {
      // Exceção do SDK/fetch (rede fora do ar, CORS): mensagem de conexão.
      setError(SIGN_IN_MESSAGES.network);
      setLoading(false);
    }
  }

  /** Decide, a partir de `/me`, se segue para o desafio MFA ou libera a navegação. */
  async function proceedPastSignIn() {
    let me;
    const supabase = getSupabaseClient();
    try {
      me = await fetchMe();
    } catch {
      // F-5: sem `/me` válido (usuário inativo/sem registro local, rede) não
      // deixa a sessão AAL1 parada no storage do navegador.
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      setError("Não foi possível confirmar sua sessão agora. Tente novamente.");
      setLoading(false);
      return;
    }

    if (!me.mfa_required || me.current_aal === "aal2") {
      router.push("/");
      setRedirecting(true);
      return;
    }

    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      setError("Não foi possível carregar a verificação em duas etapas. Tente novamente.");
      setLoading(false);
      return;
    }

    const totpFactor = factorsData.totp[0];
    if (!totpFactor) {
      // Sem fator verificado: conduz ao cadastro do primeiro fator (bootstrap).
      try {
        setEnrollment(await startTotpEnrollment(supabase));
      } catch {
        setError("Não foi possível iniciar a verificação em duas etapas. Tente novamente.");
        setLoading(false);
        return;
      }
      setCode("");
      setStep("enroll");
      setLoading(false);
      return;
    }

    setFactorId(totpFactor.id);
    setStep("mfa");
    setLoading(false);
  }

  /** Descarta fator pendente (se houver) e a sessão AAL1 parcial; volta ao e-mail. */
  function handleBack() {
    const pendingFactorId = step === "enroll" ? enrollment?.factorId : null;
    const supabase = getSupabaseClient();
    void (async () => {
      if (pendingFactorId) await discardUnverifiedFactor(supabase, pendingFactorId);
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    })();
    setEnrollment(null);
    setFactorId(null);
    setStep("credentials");
    setCode("");
    setPassword("");
    setError(null);
    setReturnFocusToEmail(true);
  }

  async function handleMfaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const activeFactorId = step === "enroll" ? enrollment?.factorId : factorId;
    if (!activeFactorId) return;
    setError(null);
    setLoading(true);

    try {
      const supabase = getSupabaseClient();
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: activeFactorId,
        code,
      });

      if (verifyError) {
        setError("Código inválido ou expirado. Tente novamente.");
        setCode("");
        setLoading(false);
        return;
      }

      // Cadastro do 1º fator concluído: aviso best-effort ao backend (falha
      // ignorada; não bloqueia nem atrasa o login).
      if (step === "enroll") void notifyMfaFactorAdded();

      // Re-confirma o AAL via backend antes de liberar a navegação para a
      // área administrativa (nunca confiar só no retorno do SDK Supabase).
      const me = await fetchMe();
      if (me.current_aal !== "aal2") {
        setError("Não foi possível confirmar a verificação em duas etapas. Tente novamente.");
        setLoading(false);
        return;
      }

      // Confirmado: o segredo TOTP/QR não é mais necessário em memória.
      setEnrollment(null);
      setCode("");
      router.push("/");
      setRedirecting(true);
    } catch {
      setError("Não foi possível verificar o código agora. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4 sm:p-8">
      <div className="grid w-full max-w-sm gap-10 lg:max-w-[56rem] lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-center xl:gap-14">
        <SlideIn
          distance="sm"
          className="flex w-full min-w-0 flex-col gap-6 rounded-cards border border-ash-stroke p-card-padding"
        >
          <FadeIn key={step} className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h1 className="text-heading text-[28px] text-bone">
                {step === "credentials"
                  ? "Entrar"
                  : step === "enroll"
                    ? "Ativar verificação em duas etapas"
                    : "Verificação em duas etapas"}
              </h1>
              <p className="text-body-sm text-warm-granite">
                {step === "credentials"
                  ? "Acesse com seu e-mail institucional e senha."
                  : step === "enroll"
                    ? "Sua conta exige verificação em duas etapas. Escaneie o QR code (ou digite a chave) em um aplicativo autenticador e informe o código de 6 dígitos."
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
            ) : step === "enroll" && !enrollment ? null : (
              <form className="flex flex-col gap-4" onSubmit={handleMfaSubmit}>
                {step === "enroll" && enrollment && (
                  <TotpEnrollDetails
                    qrCodeDataUri={enrollment.qrCodeDataUri}
                    secret={enrollment.secret}
                  />
                )}
                <AuthField label={step === "enroll" ? "Código de 6 dígitos" : "Código de verificação"}>
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    maxLength={step === "enroll" ? 6 : 10}
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

                <Button
                  type="submit"
                  loading={loading}
                  disabled={step === "enroll" ? code.length !== 6 : code.length === 0}
                  className="w-full"
                >
                  {loading
                    ? "Verificando…"
                    : step === "enroll"
                      ? "Verificar e ativar"
                      : "Verificar"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading}
                  className="w-full"
                  onClick={handleBack}
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
