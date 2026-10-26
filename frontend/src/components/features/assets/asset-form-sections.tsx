"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  FormField,
  inputLightClassName,
  selectControlLightClassName,
  textareaControlLightClassName,
} from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AssetCategory, AssetRecord, LocatedStatus, OperationalStatus, TechType } from "@/lib/assets-api";
import type { AccessibleUnit } from "@/lib/catalog-api";
import { unitLabel } from "@/components/features/users/unit-checkbox-list";
import {
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  LOCATED_LABEL,
  LOCATED_OPTIONS,
  NOT_INFORMED_LABEL,
  OPERATIONAL_STATUS_LABEL,
  OPERATIONAL_STATUS_OPTIONS,
  PATRIMONY_MAX,
  TECH_TYPE_LABEL,
  TECH_TYPE_OPTIONS,
  TEXT_MAX,
  unitRefText,
} from "./asset-labels";
import type { AssetFormValues, ChangeKey, NamedOption } from "./asset-form-model";

// =============================================================================
// Seções do formulário de bem (Dialog claro). Mesma ordem do painel de detalhe:
// Identificação, Localização e responsável, Classificação técnica e, só para
// ADM, o subgrupo "Somente administrador". Cada campo alterado ganha um ponto de
// 6px (signal-orange = voz de estado) + texto "alterado" para leitor de tela —
// nunca só cor. Controles com as classes "light" (contraste correto sobre bone).
// Apresentação apenas: quem decide é o backend.
// =============================================================================

export interface LookupState {
  options: NamedOption[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

export interface AssetFormSectionsProps {
  /** Bem de origem (`null` = criação). */
  asset: AssetRecord | null;
  values: AssetFormValues;
  changed: ReadonlySet<ChangeKey>;
  errors: Partial<Record<"unit" | "patrimony", string>>;
  pending: boolean;
  isAdmin: boolean;
  hasNotes: boolean;
  activeUnits: AccessibleUnit[] | undefined;
  ownerUnits: { id: string; code: string; name: string }[];
  rooms: LookupState;
  people: LookupState;
  /** Rótulo do Tipo de TI que foi limpo ao trocar a categoria (aviso). */
  clearedTechLabel: string | null;
  onChange: <K extends keyof AssetFormValues>(key: K, value: AssetFormValues[K]) => void;
  onChooseUnit: (unitId: string) => void;
  onChooseCategory: (category: AssetCategory | "") => void;
}

/** Ponto "alterado": 6px + texto só para leitor de tela. */
export function ChangedMark({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-signal-orange align-middle ring-1 ring-obsidian-canvas/70"
      />
      <span className="sr-only"> alterado</span>
    </>
  );
}

export function FormSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 rounded-cards border border-graphite-mid/40 p-4", className)}>
      <h3 className="text-eyebrow text-graphite-mid">{title}</h3>
      {children}
    </div>
  );
}

/** Campo somente leitura: cadeado + valor + por que não dá para editar. */
export function LockedField({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-eyebrow text-graphite-mid">
        <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />
        {label}
      </span>
      <p className="break-words text-body-sm text-obsidian-canvas [overflow-wrap:anywhere]">{children}</p>
      <p className="text-caption text-graphite-mid">{help}</p>
    </div>
  );
}

function LookupHint({ kind, unitSelected, state }: { kind: "salas" | "responsáveis"; unitSelected: boolean; state: LookupState }) {
  if (!unitSelected) return <>Escolha a unidade para listar {kind === "salas" ? "as salas" : "os responsáveis"}.</>;
  if (state.loading) return <span role="status">Carregando {kind}…</span>;
  if (state.error) return <>Não foi possível carregar {kind === "salas" ? "as salas" : "os responsáveis"}.</>;
  return null;
}

export function AssetFormSections({
  asset,
  values,
  changed,
  errors,
  pending,
  isAdmin,
  hasNotes,
  activeUnits,
  ownerUnits,
  rooms,
  people,
  clearedTechLabel,
  onChange,
  onChooseUnit,
  onChooseCategory,
}: AssetFormSectionsProps) {
  const editing = !!asset;
  const mark = (key: ChangeKey) => <ChangedMark changed={changed.has(key)} />;
  const unitSelected = !!values.unitId;

  const roomHint = <LookupHint kind="salas" unitSelected={unitSelected} state={rooms} />;
  const personHint = <LookupHint kind="responsáveis" unitSelected={unitSelected} state={people} />;
  const roomHintVisible = !unitSelected || rooms.loading || rooms.error;
  const personHintVisible = !unitSelected || people.loading || people.error;

  return (
    <>
      <FormSection title="Identificação">
        {asset ? (
          <LockedField label="Unidade" help="A unidade do bem não pode ser trocada por aqui.">
            {unitRefText(asset.unit)}
          </LockedField>
        ) : (
          <FormField id="bem-unidade" label="Unidade" required error={errors.unit} surface="light">
            {(field) => (
              <select
                {...field}
                name="unit_id"
                className={selectControlLightClassName}
                value={values.unitId}
                disabled={pending || !activeUnits}
                onChange={(event) => onChooseUnit(event.target.value)}
              >
                <option value="">Selecione…</option>
                {activeUnits?.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unitLabel(unit)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        )}

        {asset && !isAdmin ? (
          <LockedField label="Número patrimonial" help="Somente um administrador altera o número patrimonial.">
            <span translate="no" className="font-mono">
              {asset.patrimony_number}
            </span>
          </LockedField>
        ) : (
          <FormField
            id="bem-numero"
            label={
              <>
                Número patrimonial
                {mark("patrimony")}
              </>
            }
            required
            error={errors.patrimony}
            surface="light"
            hint="Texto: zeros à esquerda são preservados. Até 64 caracteres."
          >
            {(field) => (
              <Input
                {...field}
                name="patrimony_number"
                autoComplete="off"
                spellCheck={false}
                translate="no"
                maxLength={PATRIMONY_MAX}
                className={cn("font-mono", inputLightClassName)}
                value={values.patrimony}
                disabled={pending}
                onChange={(event) => onChange("patrimony", event.target.value)}
              />
            )}
          </FormField>
        )}

        <FormField
          id="bem-descricao"
          label={
            <>
              Descrição
              {mark("description")}
            </>
          }
          surface="light"
        >
          {(field) => (
            <textarea
              {...field}
              name="description"
              maxLength={TEXT_MAX}
              className={textareaControlLightClassName}
              value={values.description}
              disabled={pending}
              onChange={(event) => onChange("description", event.target.value)}
            />
          )}
        </FormField>

        {hasNotes ? (
          <FormField
            id="bem-observacoes"
            label={
              <>
                Observações
                {mark("notes")}
              </>
            }
            surface="light"
          >
            {(field) => (
              <textarea
                {...field}
                name="notes"
                maxLength={TEXT_MAX}
                className={textareaControlLightClassName}
                value={values.notes}
                disabled={pending}
                onChange={(event) => onChange("notes", event.target.value)}
              />
            )}
          </FormField>
        ) : null}

        <FormField
          id="bem-data"
          label={
            <>
              Data de registro
              {mark("date")}
            </>
          }
          surface="light"
        >
          {(field) => (
            <Input
              {...field}
              type="date"
              name="registration_date"
              min="1900-01-01"
              className={inputLightClassName}
              value={values.registrationDate}
              disabled={pending}
              onChange={(event) => onChange("registrationDate", event.target.value)}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection title="Localização e responsável">
        <div className="flex flex-col items-start gap-1.5">
          <FormField
            className="w-full"
            id="bem-sala"
            label={
              <>
                Sala
                {mark("room")}
              </>
            }
            surface="light"
            hint={roomHintVisible ? roomHint : undefined}
          >
            {(field) => (
              <select
                {...field}
                name="room_id"
                className={selectControlLightClassName}
                value={values.roomId}
                aria-busy={rooms.loading || undefined}
                disabled={pending || !unitSelected}
                onChange={(event) => onChange("roomId", event.target.value)}
              >
                <option value="">Nenhuma</option>
                {rooms.options.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {unitSelected && rooms.error ? (
            <Button type="button" variant="outlineOnLight" size="sm" onClick={rooms.retry}>
              Recarregar salas
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col items-start gap-1.5">
          <FormField
            className="w-full"
            id="bem-responsavel"
            label={
              <>
                Responsável
                {mark("person")}
              </>
            }
            surface="light"
            hint={personHintVisible ? personHint : undefined}
          >
            {(field) => (
              <select
                {...field}
                name="responsible_person_id"
                className={selectControlLightClassName}
                value={values.personId}
                aria-busy={people.loading || undefined}
                disabled={pending || !unitSelected}
                onChange={(event) => onChange("personId", event.target.value)}
              >
                <option value="">Nenhum</option>
                {people.options.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {unitSelected && people.error ? (
            <Button type="button" variant="outlineOnLight" size="sm" onClick={people.retry}>
              Recarregar responsáveis
            </Button>
          ) : null}
        </div>

        {asset?.location ? (
          <div className="flex flex-col gap-2">
            <LockedField
              label="Local"
              help="O local não tem lista de escolha: dá para mantê-lo ou removê-lo."
            >
              {values.removeLocation ? "Será removido ao salvar" : asset.location.name}
            </LockedField>
            <label className="flex min-h-6 items-start gap-2 text-body-sm text-obsidian-canvas">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-obsidian-canvas"
                checked={values.removeLocation}
                disabled={pending}
                onChange={(event) => onChange("removeLocation", event.target.checked)}
              />
              <span>Remover a localização atual deste bem</span>
            </label>
            {changed.has("room") ? (
              <p className="text-caption text-graphite-mid">
                Ao trocar a sala, o local atual pode deixar de pertencer a ela. Se o salvamento for recusado, marque
                “Remover a localização atual”.
              </p>
            ) : null}
          </div>
        ) : null}
      </FormSection>

      {editing ? (
        <FormSection title="Classificação técnica">
          <FormField
            id="bem-categoria"
            label={
              <>
                Categoria
                {mark("category")}
              </>
            }
            surface="light"
          >
            {(field) => (
              <select
                {...field}
                name="asset_category"
                className={selectControlLightClassName}
                value={values.category}
                disabled={pending}
                onChange={(event) => onChooseCategory(event.target.value as AssetCategory | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {CATEGORY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="bem-tipo-ti"
            label={
              <>
                Tipo de TI
                {mark("techType")}
              </>
            }
            surface="light"
            hint={values.category !== "TECNOLOGIA" ? "Disponível só para a categoria Tecnologia." : undefined}
          >
            {(field) => (
              <select
                {...field}
                name="tech_type"
                className={selectControlLightClassName}
                value={values.techType}
                disabled={pending || values.category !== "TECNOLOGIA"}
                onChange={(event) => onChange("techType", event.target.value as TechType | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {TECH_TYPE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {TECH_TYPE_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {clearedTechLabel ? (
            <p role="status" className="text-caption text-graphite-mid">
              Ao mudar a categoria, o Tipo de TI “{clearedTechLabel}” foi limpo. Escolha Tecnologia de novo para
              informá-lo.
            </p>
          ) : null}
          <FormField
            id="bem-situacao"
            label={
              <>
                Situação operacional
                {mark("opStatus")}
              </>
            }
            surface="light"
          >
            {(field) => (
              <select
                {...field}
                name="operational_status"
                className={selectControlLightClassName}
                value={values.opStatus}
                disabled={pending}
                onChange={(event) => onChange("opStatus", event.target.value as OperationalStatus | "")}
              >
                <option value="">{NOT_INFORMED_LABEL}</option>
                {OPERATIONAL_STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {OPERATIONAL_STATUS_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </FormSection>
      ) : null}

      {isAdmin ? (
        <FormSection title="Somente administrador">
          <FormField
            id="bem-proprietaria"
            label={
              <>
                Unidade proprietária
                {mark("owner")}
              </>
            }
            surface="light"
          >
            {(field) => (
              <select
                {...field}
                name="owner_unit_id"
                className={selectControlLightClassName}
                value={values.ownerUnitId}
                disabled={pending || !activeUnits}
                onChange={(event) => onChange("ownerUnitId", event.target.value)}
              >
                <option value="">Nenhuma</option>
                {ownerUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unitLabel(unit)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="bem-localizado"
            label={
              <>
                Localizado
                {mark("located")}
              </>
            }
            surface="light"
          >
            {(field) => (
              <select
                {...field}
                name="located"
                className={selectControlLightClassName}
                value={values.located}
                disabled={pending}
                onChange={(event) => onChange("located", event.target.value as LocatedStatus)}
              >
                {LOCATED_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {LOCATED_LABEL[status]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </FormSection>
      ) : null}
    </>
  );
}
