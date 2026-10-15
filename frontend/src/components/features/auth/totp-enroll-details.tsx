"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

// =============================================================================
// TotpEnrollDetails — QR code + chave manual do cadastro do 1º fator TOTP.
// =============================================================================
// Apresentação pura. O segredo e o QR são recebidos por props (memória do
// componente pai), nunca persistidos nem registrados em log; sem animação no
// bloco (dado sensível). QR: só data URI SVG já validado por `@/lib/mfa`.
// A chave é texto simples (legível por leitor de tela, selecionável) e há um
// botão para copiá-la por ação explícita do usuário.
// =============================================================================

export interface TotpEnrollDetailsProps {
  qrCodeDataUri: string | null;
  secret: string;
}

export function TotpEnrollDetails({ qrCodeDataUri, secret }: TotpEnrollDetailsProps) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {qrCodeDataUri && (
        // eslint-disable-next-line @next/next/no-img-element -- SVG data URI do Supabase, não otimizável pelo next/image
        <img
          src={qrCodeDataUri}
          alt="QR code para configurar o aplicativo autenticador"
          className="size-32 shrink-0 rounded-sm bg-bone p-2"
        />
      )}
      <div className="flex min-w-[10rem] flex-1 flex-col items-start gap-2">
        <span className="text-eyebrow text-pale-stone">
          Chave manual
        </span>
        <code
          className="w-full select-all break-all rounded-buttons border border-ash-stroke bg-carbon-lift px-3 py-2 text-caption text-pale-stone"
        >
          {grouped}
        </code>
        <Button type="button" variant="ghost" size="sm" onClick={copy}>
          Copiar chave
        </Button>
        <p role="status" className="text-caption text-warm-granite empty:hidden">
          {copied === "ok" ? "Chave copiada." : copied === "fail" ? "Não foi possível copiar; selecione o texto." : ""}
        </p>
      </div>
    </div>
  );
}
