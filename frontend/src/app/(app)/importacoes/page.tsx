"use client";

import { AdminRedirect } from "@/components/features/modules/admin-redirect";

// /importacoes: a importação de dados é administrativa. ADM segue para a
// importação dos cadastros de apoio; demais perfis veem acesso restrito.
export default function ImportacoesPage() {
  return (
    <AdminRedirect
      to="/administracao/importacao/cadastros"
      title="Importações"
      eyebrow="Importações"
      restrictedMessage="A importação de dados é feita por administradores (perfil ADM). Se você precisa importar dados, peça a um administrador."
    />
  );
}
