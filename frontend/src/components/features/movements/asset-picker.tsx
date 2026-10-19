"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { FormField, selectControlClassName } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { listAssets, type AssetRecord } from "@/lib/assets-api";
import { SEARCH_DEBOUNCE_MS } from "@/components/features/catalog/catalog-labels";
import { noClientRetry } from "@/components/features/lookup/use-lookup";
import { ASSET_PICK_PAGE_SIZE, ASSET_SEARCH_MAX } from "./movement-labels";

// =============================================================================
// Seletor de bem: busca em `GET /api/v1/assets` (debounce 300 ms, ≤100 caracteres,
// no máximo 10 resultados) e escolha em <select> nativo. O escopo de unidade é
// aplicado pelo backend (bem alheio nem aparece). O número patrimonial é TEXTO.
// =============================================================================

export function assetOptionLabel(asset: Pick<AssetRecord, "patrimony_number" | "description">): string {
  return asset.description ? `${asset.patrimony_number} — ${asset.description}` : asset.patrimony_number;
}

export function AssetPicker({
  idPrefix,
  value,
  onChange,
  surface = "dark",
  disabled = false,
  label = "Bem",
  clearLabel = "Trocar bem",
  required = false,
  error,
}: {
  idPrefix: string;
  value: AssetRecord | null;
  onChange: (asset: AssetRecord | null) => void;
  surface?: "dark" | "light";
  disabled?: boolean;
  label?: string;
  clearLabel?: string;
  required?: boolean;
  error?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const results = useQuery({
    queryKey: ["movements", "asset-picker", q],
    queryFn: () => listAssets({ q, page_size: ASSET_PICK_PAGE_SIZE, sort: "patrimony_number" }),
    enabled: !value && q.length > 0,
    staleTime: 15_000,
    retry: noClientRetry,
  });

  if (value) {
    const textClass = surface === "light" ? "text-obsidian-canvas" : "text-bone";
    return (
      <div className="flex flex-col gap-1.5">
        <span className={surface === "light" ? "text-eyebrow text-graphite-mid" : "text-eyebrow text-pale-stone"}>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </span>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`min-w-0 break-words text-body-sm [overflow-wrap:anywhere] ${textClass}`}>
            <span translate="no" className="font-mono">
              {value.patrimony_number}
            </span>
            {value.description ? ` — ${value.description}` : ""}
          </p>
          <Button
            type="button"
            variant={surface === "light" ? "outlineOnLight" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => {
              setSearch("");
              setQ("");
              onChange(null);
            }}
          >
            {clearLabel}
          </Button>
        </div>
      </div>
    );
  }

  const list = results.data?.assets ?? [];
  let hint: string;
  if (q.length === 0) hint = "Digite o número patrimonial ou parte da descrição.";
  else if (results.isError) hint = "Não foi possível buscar os bens agora. Tente novamente.";
  else if (results.isPending) hint = "Buscando…";
  else if (list.length === 0) hint = "Nenhum bem encontrado no seu escopo para esta busca.";
  else hint = `${results.data!.total} bem(ns) encontrado(s); mostrando até ${ASSET_PICK_PAGE_SIZE}. Refine a busca se preciso.`;

  return (
    <div className="flex flex-col gap-3">
      <FormField
        id={`${idPrefix}-busca`}
        label={`${label} — buscar por patrimônio ou descrição`}
        surface={surface}
        required={required}
        error={error}
        hint={<span aria-live="polite">{hint}</span>}
      >
        {(field) => (
          <Input
            {...field}
            type="search"
            autoComplete="off"
            maxLength={ASSET_SEARCH_MAX}
            placeholder="Ex.: 000123 ou cadeira"
            value={search}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </FormField>
      {list.length > 0 ? (
        <FormField id={`${idPrefix}-resultado`} label={`${label} — resultados`} surface={surface}>
          {(field) => (
            <select
              {...field}
              className={selectControlClassName}
              value=""
              disabled={disabled}
              onChange={(event) => {
                const picked = list.find((asset) => asset.id === event.target.value);
                if (picked) onChange(picked);
              }}
            >
              <option value="">Selecione o bem…</option>
              {list.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {assetOptionLabel(asset)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}
    </div>
  );
}
