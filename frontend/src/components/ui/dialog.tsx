"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

// =============================================================================
// Dialog — padrão shadcn/ui sobre @radix-ui/react-dialog (acessibilidade,
// foco e Escape/overlay já resolvidos pelo Radix). Conteúdo segue "Light
// Surface Card" do DESIGN.md: superfície clara (#eeeeee) flutuando sobre o
// canvas escuro, raio 10px, padding 24px, ZERO box-shadow (profundidade vem
// do contraste figura/fundo, não de blur) — ver DESIGN.md > Elevation.
// =============================================================================

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Overlay: fade 200ms na entrada / 150ms na saída (tailwind.config.ts).
      "fixed inset-0 z-50 bg-obsidian-canvas/80 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  // WCAG 2.4.3 (Focus Order): ao fechar, o foco volta ao elemento que abriu o
  // diálogo. Nos diálogos controlados (sem DialogTrigger) o Radix perdia essa
  // referência — sob reactStrictMode o FocusScope remonta já com o foco dentro
  // do diálogo — e o foco caía no <body>. Guardamos o elemento de origem na
  // primeira abertura (ignorando focos já internos ao diálogo).
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onOpenAutoFocus={(event) => {
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && !active.closest("[role='dialog']")) {
          returnFocusRef.current = active;
        }
        onOpenAutoFocus?.(event);
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        const target = returnFocusRef.current;
        returnFocusRef.current = null;
        if (!event.defaultPrevented && target?.isConnected) {
          event.preventDefault();
          target.focus();
        }
      }}
      className={cn(
        // w-[calc(100%-2rem)]: 16px de respiro lateral em telas de 320px;
        // max-h + overflow-y-auto: o modal nunca ultrapassa a altura da tela
        // (conteúdo rola dentro dele), inclusive em 320x568 / paisagem.
        "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-cards bg-bone p-card-padding text-obsidian-canvas",
        // Entrada fade + scale 0.98→1 (200ms) e saída inversa (150ms), ease
        // factory. Anima a propriedade CSS `scale`, que compõe com o
        // translate(-50%,-50%) acima. O Radix Presence aguarda o animationend
        // da saída antes de desmontar — foco/Esc/retorno de foco intactos.
        // (As classes antigas animate-in/zoom-in-95 dependiam do plugin
        // tailwindcss-animate, não instalado — eram no-op.)
        "data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out",
        className,
      )}
      {...props}
    >
      {children}
      {/* Alvo de 32px (WCAG 2.5.8 >= 24px); cor graphite-mid (7.8:1 sobre bone). */}
      <DialogPrimitive.Close className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-sm text-graphite-mid transition-colors hover:text-obsidian-canvas focus:outline-none focus-visible:ring-1 focus-visible:ring-obsidian-canvas disabled:pointer-events-none">
        <X className="h-4 w-4" aria-hidden />
        <span className="sr-only">Fechar</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />;
}
DialogHeader.displayName = "DialogHeader";

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("pr-8 text-heading text-[24px] font-regular leading-tight text-obsidian-canvas sm:text-[28px]", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body-sm text-graphite-mid", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
