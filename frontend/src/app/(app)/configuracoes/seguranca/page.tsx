"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Factor } from "@supabase/supabase-js";
import { CheckCircle2 } from "lucide-react";

import { FadeIn } from "@/components/animations";
import { AnimatedFormMessage, StepIndicator } from "@/components/features/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "@/components/ui/form-message";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getSupabaseClient } from "@/lib/supabase-client";
import { toSafeQrCodeDataUri } from "@/lib/mfa";
import { throttleOrForbiddenMessage } from "@/lib/api-errors";
import { ApiError, notifyMfaFactorAdded, removeMfaFactor } from "@/lib/users-api";

// =============================================================================
// /configuracoes/seguranca — Verificação em duas etapas (MFA)
// =============================================================================
// Enrollment/challenge/listagem de fatores são feitos DIRETAMENTE via SDK do
// Supabase no navegador (`supabase.auth.mfa.*`, ANON KEY — ver
// `supabase-client.ts`). A REMOÇÃO de fator passa pelo backend
// (`DELETE /api/v1/security/mfa/factors/{factor_id}`, via `removeMfaFactor`
// em `users-api.ts`) e NUNCA por `supabase.auth.mfa.unenroll()` direto, para
// que a regra "ADM não pode remover o único fator ativo" (409) seja
// respeitada pelo backend.
//
// Recuperação de dispositivo perdido: PENDÊNCIA da próxima rodada — este
// fluxo precisa de um procedimento administrativo assistido (um admin
// confirma a identidade do usuário fora de banda e então remove o fator em
// nome dele). Por ora exibimos apenas uma instrução estática.
//
// Apresentação: indicador de etapas da ativação (QR code → código →
// concluído) que só avança para "concluído" após a resposta REAL do
// `challengeAndVerify`; skeleton enquanto os fatores carregam; erros com
// AnimatedFormMessage (role="alert"); `<Button loading>`. O bloco do QR
// code/chave manual NÃO é animado nem registrado em log (segredo TOTP).
// =============================================================================

const ENROLL_STEPS = ["Escanear QR code", "Informar código", "Concluído"];

type EnrollmentState = {
  factorId: string;
  qrCodeDataUri: string | null;
  secret: string;
};

export default function SegurancaPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [factors, setFactors] = useState<Factor[]>([]);

  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  // Só apresentação: confirmação exibida após a verificação real do fator.
  const [justEnrolled, setJustEnrolled] = useState(false);

  const [factorToRemove, setFactorToRemove] = useState<Factor | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadFactors = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      setFactors(data.all);
    } catch {
      setLoadError("Não foi possível carregar seus fatores de autenticação. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFactors();
  }, [loadFactors]);

  async function handleStartEnrollment() {
    setEnrollError(null);
    setJustEnrolled(false);
    setEnrolling(true);
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) {
        setEnrollError("Não foi possível iniciar a ativação do MFA. Tente novamente.");
        return;
      }
      setEnrollment({
        factorId: data.id,
        // auth-js 2.117 já devolve o data URI pronto; `toSafeQrCodeDataUri`
        // evita prefixo duplicado e só aceita data URI SVG (ver @/lib/mfa).
        qrCodeDataUri: toSafeQrCodeDataUri(data.totp.qr_code),
        secret: data.totp.secret,
      });
      setCode("");
    } finally {
      setEnrolling(false);
    }
  }

  async function handleConfirmEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment) return;
    setEnrollError(null);
    setVerifying(true);
    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code,
      });
      if (error) {
        setEnrollError("Código inválido ou expirado. Tente novamente.");
        setCode("");
        return;
      }
      // Fator verificado: aviso best-effort ao backend (falha ignorada).
      void notifyMfaFactorAdded();
      setEnrollment(null);
      setCode("");
      setJustEnrolled(true);
      await loadFactors();
    } finally {
      setVerifying(false);
    }
  }

  function handleCancelEnrollment() {
    setEnrollment(null);
    setEnrollError(null);
    setCode("");
    // O fator fica "unverified" no Supabase até ser confirmado ou expirar
    // sozinho; não há endpoint de remoção de fator não-verificado além do
    // backend (que só remove fatores do próprio usuário autenticado), então
    // apenas descartamos a tela — o próximo "Ativar MFA" cria um novo fator.
  }

  async function handleRemoveConfirmed() {
    if (!factorToRemove) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeMfaFactor(factorToRemove.id);
      setFactorToRemove(null);
      setJustEnrolled(false);
      await loadFactors();
    } catch (cause) {
      setRemoveError(removeErrorMessage(cause));
    } finally {
      setRemoving(false);
    }
  }

  const verifiedFactors = factors.filter((f) => f.status === "verified");

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <span className="text-eyebrow text-pale-stone">Configurações</span>
        <h1 className="text-heading text-bone">Segurança</h1>
        <p className="max-w-page text-body-sm text-warm-granite">
          Gerencie a verificação em duas etapas (MFA) da sua conta.
        </p>
      </div>

      <section className="flex max-w-lg flex-col gap-4 rounded-cards border border-ash-stroke p-card-padding">
        <h2 className="text-body text-bone">Autenticação em duas etapas (TOTP)</h2>

        {(enrollment || justEnrolled) && (
          <StepIndicator
            label="Etapas da ativação do MFA"
            steps={ENROLL_STEPS}
            current={justEnrolled ? ENROLL_STEPS.length : code.length > 0 ? 1 : 0}
          />
        )}

        {loading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span role="status" className="sr-only">
              Carregando fatores de autenticação…
            </span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {!loading && loadError && (
          <FadeIn className="flex flex-col gap-3">
            <FormMessage>{loadError}</FormMessage>
            <Button variant="outline" size="sm" className="self-start" onClick={loadFactors}>
              Tentar novamente
            </Button>
          </FadeIn>
        )}

        {!loading && !loadError && justEnrolled && enrollment === null && (
          <FadeIn>
            <p role="status" className="flex items-center gap-2 text-body-sm text-metric-green">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
              Verificação em duas etapas ativada.
            </p>
          </FadeIn>
        )}

        {!loading && !loadError && enrollment === null && (
          <>
            {verifiedFactors.length === 0 ? (
              <FadeIn className="flex flex-col gap-3">
                <p className="text-body-sm text-warm-granite">
                  Você ainda não tem um fator de autenticação configurado.
                </p>
                <Button onClick={handleStartEnrollment} loading={enrolling} className="self-start">
                  {enrolling ? "Preparando…" : "Ativar MFA"}
                </Button>
                <AnimatedFormMessage message={enrollError} />
              </FadeIn>
            ) : (
              <FadeIn>
                <ul className="flex flex-col gap-3">
                  {verifiedFactors.map((factor) => (
                    <li
                      key={factor.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-buttons border border-ash-stroke px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-col items-start gap-1">
                        <span className="break-words text-body-sm text-bone [overflow-wrap:anywhere]">
                          {factor.friendly_name || "Autenticador TOTP"}
                        </span>
                        <Badge variant="success">Verificado</Badge>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setRemoveError(null);
                          setFactorToRemove(factor);
                        }}
                      >
                        Remover
                      </Button>
                    </li>
                  ))}
                </ul>
              </FadeIn>
            )}
          </>
        )}

        {enrollment && (
          <form className="flex flex-col gap-4" onSubmit={handleConfirmEnrollment}>
            <p className="text-body-sm text-warm-granite">
              Escaneie o QR code com seu aplicativo autenticador (Google Authenticator, Authy,
              etc.) ou informe a chave manualmente, depois digite o código gerado para confirmar.
            </p>

            {enrollment.qrCodeDataUri && (
              // eslint-disable-next-line @next/next/no-img-element -- SVG data URI gerado pelo Supabase, não um asset otimizável pelo next/image
              <img
                src={enrollment.qrCodeDataUri}
                alt="QR code para configurar o aplicativo autenticador"
                className="h-40 w-40 self-center rounded-sm bg-bone p-2"
              />
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-eyebrow text-pale-stone">Chave manual</span>
              <code className="break-all rounded-buttons border border-ash-stroke bg-carbon-lift px-3 py-2 text-caption text-pale-stone">
                {enrollment.secret}
              </code>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-eyebrow text-pale-stone">Código do aplicativo</span>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="000000"
                maxLength={10}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={verifying}
                autoComplete="one-time-code"
                aria-invalid={enrollError ? true : undefined}
                aria-describedby={enrollError ? "mfa-erro" : undefined}
              />
            </label>

            <AnimatedFormMessage id="mfa-erro" message={enrollError} />

            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={verifying} disabled={code.length === 0}>
                {verifying ? "Confirmando…" : "Confirmar"}
              </Button>
              <Button type="button" variant="ghost" onClick={handleCancelEnrollment} disabled={verifying}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className="flex max-w-lg flex-col gap-2 rounded-cards border border-ash-stroke p-card-padding">
        <h2 className="text-body text-bone">Perdeu seu dispositivo autenticador?</h2>
        <p className="text-body-sm text-warm-granite">
          Solicite a um administrador que remova seu fator de autenticação atual. Após a remoção,
          você poderá configurar um novo dispositivo em seu próximo login.
        </p>
        {/* TODO (próxima rodada): fluxo administrativo assistido completo de
            recuperação (ex.: solicitação formal, verificação de identidade,
            auditoria da remoção feita em nome do usuário). Hoje isto é só
            uma instrução estática — a remoção administrativa em si ainda não
            tem uma tela dedicada. */}
      </section>

      <Dialog open={!!factorToRemove} onOpenChange={(open) => !open && setFactorToRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover fator de autenticação</DialogTitle>
            <DialogDescription>
              Tem certeza de que deseja remover{" "}
              {factorToRemove?.friendly_name || "este fator de autenticação"}? Você precisará
              configurar um novo fator para continuar usando a verificação em duas etapas.
            </DialogDescription>
          </DialogHeader>

          <AnimatedFormMessage surface="light" message={removeError} />

          <DialogFooter>
            <Button variant="outlineOnLight" onClick={() => setFactorToRemove(null)} disabled={removing}>
              Cancelar
            </Button>
            {/* Sobre cartão claro: botão escuro (destructive laranja = 2.9:1 sobre bone). */}
            <Button onClick={handleRemoveConfirmed} loading={removing}>
              {removing ? "Removendo…" : "Remover"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function removeErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) {
      return "Não é possível remover o último fator de autenticação de uma conta ADM. Mantenha pelo menos um fator ativo ou peça a outro administrador para realizar a remoção.";
    }
    if (cause.status === 401) {
      return "Sessão não autenticada. Faça login novamente.";
    }
    if (cause.status === 404) {
      return "Este fator já não existe mais.";
    }
    const generic = throttleOrForbiddenMessage(cause);
    if (generic) return generic;
  }
  return "Não foi possível remover o fator agora. Tente novamente.";
}
