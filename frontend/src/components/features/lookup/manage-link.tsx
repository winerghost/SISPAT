"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

// Atalho para o cadastro (escrita) — só aparece para ADM. UX: o backend decide.
export function ManageLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "outline", size: "sm" })}>
      {label}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}
