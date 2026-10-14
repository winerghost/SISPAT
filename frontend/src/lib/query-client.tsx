"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * Provider do TanStack Query para toda a árvore do App Router.
 *
 * Client Component: o QueryClient precisa ser instanciado uma única vez por
 * sessão do navegador (useState garante que sobrevive a re-renders sem ser
 * recriado, mas é recriado a cada novo carregamento de página/SSR, evitando
 * compartilhar cache entre requisições de usuários diferentes no servidor).
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Dados patrimoniais não são "tempo real"; evita refetch agressivo.
            staleTime: 30 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
