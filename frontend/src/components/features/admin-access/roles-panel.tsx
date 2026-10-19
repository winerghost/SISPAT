"use client";

import { Check, UserRound } from "lucide-react";

import { StaggerContainer, StaggerItem } from "@/components/animations";
import { ActiveBadge } from "@/components/features/catalog/catalog-parts";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { groupByResource, type AccessRole } from "@/lib/admin-access-api";

// =============================================================================
// Aba "Perfis": um cartão por perfil (Feature Card: borda hairline, raio 10px).
// Texto da API é renderizado como texto puro (escape do React).
// =============================================================================

export function RolesPanel({ roles }: { roles: AccessRole[] }) {
  if (roles.length === 0) {
    return (
      <EmptyState
        title="Nenhum perfil encontrado"
        description="O servidor não devolveu perfis. Se isso não era esperado, procure o suporte."
      />
    );
  }
  return (
    <>
      <p className="max-w-page text-body-sm text-warm-granite" data-testid="users-count-note">
        A contagem de usuários ativos considera apenas as unidades do seu escopo de acesso.
      </p>
      <StaggerContainer as="ul" className="grid list-none grid-cols-1 gap-element-gap p-0 xl:grid-cols-2">
        {roles.map((role, index) => (
          <StaggerItem as="li" key={role.code} index={index} className="min-w-0">
            <RoleCard role={role} />
          </StaggerItem>
        ))}
      </StaggerContainer>
    </>
  );
}

function RoleCard({ role }: { role: AccessRole }) {
  const groups = groupByResource(role.permissions);
  const headingId = `perfil-${role.code}`;
  return (
    <article
      aria-labelledby={headingId}
      data-testid={`role-card-${role.code}`}
      className="flex h-full min-w-0 flex-col gap-4 rounded-cards border border-ash-stroke p-card-padding"
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="text-body text-bone">
            {role.name}
          </h2>
          <ActiveBadge active={role.active} feminine={false} />
        </div>
        <span className="font-mono text-eyebrow text-pale-stone">{role.code}</span>
        {role.description ? <p className="text-body-sm text-warm-granite">{role.description}</p> : null}
      </header>

      <p className="flex items-center gap-2 text-body-sm text-bone" data-testid={`role-users-${role.code}`}>
        <UserRound className="h-4 w-4 shrink-0 text-warm-granite" aria-hidden="true" />
        <span>
          {role.active_users_count} usuário(s) ativo(s)
          <span className="text-warm-granite"> nas suas unidades</span>
        </span>
      </p>

      <section aria-label={`Permissões de ${role.name}`} className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <h3 className="text-eyebrow text-pale-stone">Permissões</h3>
          <Badge variant="outline">{role.permissions.length}</Badge>
        </div>
        {groups.length === 0 ? (
          <p className="text-body-sm text-warm-granite">Este perfil não possui permissões.</p>
        ) : (
          groups.map(([resource, perms]) => (
            <div key={resource} className="flex flex-col gap-1.5" data-resource={resource}>
              <h4 className="font-mono text-eyebrow text-warm-granite">{resource}</h4>
              <ul className="flex flex-col gap-1.5">
                {perms.map((perm) => (
                  <li key={perm.code} className="flex min-w-0 items-start gap-2 text-body-sm">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-metric-green" aria-hidden="true" />
                    <span className="min-w-0 break-words text-bone">
                      <span className="font-mono">{perm.code}</span>
                      {perm.description ? <span className="text-warm-granite"> — {perm.description}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </article>
  );
}
