"use client";

import { AdminRedirect } from "@/components/features/modules/admin-redirect";

// /administracao (pai do grupo): ADM segue para Usuários; demais perfis veem
// acesso restrito (negar por padrão — o backend autoriza cada tela).
export default function AdministracaoPage() {
  return <AdminRedirect to="/administracao/usuarios" title="Administração" eyebrow="Administração" />;
}
