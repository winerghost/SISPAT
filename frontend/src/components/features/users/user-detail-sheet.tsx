"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SlideIn } from "@/components/animations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Sheet } from "@/components/ui/sheet";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import {
  deleteUserAvatar,
  getUser,
  getUserAvatarUrl,
  uploadUserAvatar,
  type UserSummary,
} from "@/lib/users-api";
import { AvatarManager } from "./avatar-manager";
import { UserAccessForm } from "./user-access-form";
import { UserAccountActions } from "./user-account-actions";
import { userAuditQueryKey, UserAuditList } from "./user-audit-list";
import { UserAvatar, userAvatarQueryKey } from "./user-avatar";
import { CONFLICT_MESSAGE, isNotFound, userErrorMessage } from "./user-labels";

// =============================================================================
// Painel de detalhe do usuário (Sheet lateral) com quatro abas:
// Perfil e unidades · Conta · Foto · Histórico.
// Fonte: `GET /api/v1/users/<id>` (a linha da lista serve só de esboço até a
// resposta chegar). Toda resposta de escrita devolve o `UserSummary` novo,
// que substitui o cache do detalhe e invalida a lista. 409 `version_conflict`
// → recarrega o detalhe e mostra o aviso; 404 → "não encontrado ou fora do
// escopo" (o backend não diferencia, de propósito).
// =============================================================================

type Section = "perfil" | "conta" | "foto" | "historico";

const SECTIONS: readonly TabItem<Section>[] = [
  { id: "perfil", label: "Perfil e unidades" },
  { id: "conta", label: "Conta" },
  { id: "foto", label: "Foto" },
  { id: "historico", label: "Histórico" },
];

export const userDetailQueryKey = (userId: string) => ["users", "detail", userId] as const;

export interface UserDetailSheetProps {
  /** Linha selecionada na lista (esboço até o GET de detalhe responder). */
  user: UserSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string | undefined;
}

export function UserDetailSheet({ user: listUser, open, onOpenChange, currentUserId }: UserDetailSheetProps) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("perfil");
  const [conflict, setConflict] = useState(false);
  const userId = listUser?.id ?? "";

  const detail = useQuery({
    queryKey: userDetailQueryKey(userId),
    queryFn: () => getUser(userId),
    enabled: open && !!userId,
    placeholderData: listUser ?? undefined,
    retry: false,
  });

  const user = detail.data;
  const isSelf = !!user && user.id === currentUserId;

  function invalidateList() {
    void queryClient.invalidateQueries({ queryKey: ["users", "list"] });
  }

  function handleUpdated(saved: UserSummary) {
    setConflict(false);
    queryClient.setQueryData(userDetailQueryKey(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: userAuditQueryKey(saved.id) });
    invalidateList();
  }

  function handleConflict() {
    setConflict(true);
    void queryClient.invalidateQueries({ queryKey: userDetailQueryKey(userId) });
    invalidateList();
  }

  function handleAvatarChanged(hasAvatar: boolean) {
    queryClient.setQueryData<UserSummary>(userDetailQueryKey(userId), (prev) =>
      prev ? { ...prev, has_avatar: hasAvatar } : prev,
    );
    if (!hasAvatar) queryClient.removeQueries({ queryKey: userAvatarQueryKey(userId) });
    void queryClient.invalidateQueries({ queryKey: userDetailQueryKey(userId) });
    void queryClient.invalidateQueries({ queryKey: userAuditQueryKey(userId) });
    invalidateList();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setConflict(false);
          setSection("perfil");
        }
      }}
      title={user?.name ?? "Usuário"}
      description={user?.email}
    >
      {detail.isError && isNotFound(detail.error) ? (
        <div className="flex flex-col items-start gap-3">
          <FormMessage>{userErrorMessage(detail.error, "")}</FormMessage>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              invalidateList();
              onOpenChange(false);
            }}
          >
            Voltar à lista
          </Button>
        </div>
      ) : user ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <UserAvatar userId={user.id} name={user.name} hasAvatar={user.has_avatar} size="md" />
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{user.role ?? "Sem perfil"}</Badge>
              <Badge variant={user.active ? "success" : "default"}>{user.active ? "Ativo" : "Inativo"}</Badge>
              {isSelf ? <Badge variant="default">Você</Badge> : null}
            </div>
          </div>

          {conflict ? (
            <SlideIn distance="sm">
              <FormMessage className="rounded-cards border border-signal-orange/40 bg-carbon-lift p-4">
                {CONFLICT_MESSAGE}
              </FormMessage>
            </SlideIn>
          ) : null}

          {detail.isError ? (
            <FormMessage>{userErrorMessage(detail.error, "Não foi possível atualizar os dados deste usuário.")}</FormMessage>
          ) : null}

          <Tabs label="Seções do usuário" items={SECTIONS} value={section} onValueChange={setSection}>
            {section === "perfil" ? (
              <UserAccessForm
                key={`${user.id}-${user.version}`}
                user={user}
                isSelf={isSelf}
                onUpdated={handleUpdated}
                onConflict={handleConflict}
              />
            ) : null}
            {section === "conta" ? (
              <UserAccountActions
                key={user.id}
                user={user}
                isSelf={isSelf}
                onUpdated={handleUpdated}
                onConflict={handleConflict}
              />
            ) : null}
            {section === "foto" ? (
              <AvatarManager
                key={user.id}
                name={user.name}
                hasAvatar={user.has_avatar}
                subject={`a foto de ${user.name}`}
                urlQueryKey={userAvatarQueryKey(user.id)}
                fetchUrl={() => getUserAvatarUrl(user.id)}
                upload={(file) => uploadUserAvatar(user.id, file)}
                remove={() => deleteUserAvatar(user.id)}
                onChanged={handleAvatarChanged}
              />
            ) : null}
            {section === "historico" ? <UserAuditList key={user.id} userId={user.id} /> : null}
          </Tabs>
        </>
      ) : null}
    </Sheet>
  );
}
