import type {
  AssetCategory,
  AssetRecord,
  LocatedStatus,
  OperationalStatus,
  TechType,
  UpdateAssetRequest,
} from "@/lib/assets-api";
import {
  blankToNull,
  CATEGORY_LABEL,
  classificationLabel,
  formatCalendarDate,
  LOCATED_LABEL,
  OPERATIONAL_STATUS_LABEL,
  TECH_TYPE_LABEL,
  unitRefText,
} from "./asset-labels";

// =============================================================================
// Modelo do formulário de bem (apresentação): valores do rascunho, quais campos
// mudaram e o corpo do PATCH. A lista de campos alterados é a MESMA que gera o
// resumo na tela e o corpo enviado — assim o usuário vê exatamente o que vai.
// Nenhuma regra de negócio aqui: o backend valida e decide.
// =============================================================================

export interface AssetFormValues {
  unitId: string;
  patrimony: string;
  description: string;
  notes: string;
  roomId: string;
  personId: string;
  registrationDate: string;
  ownerUnitId: string;
  located: LocatedStatus;
  category: AssetCategory | "";
  techType: TechType | "";
  opStatus: OperationalStatus | "";
  removeLocation: boolean;
}

export function valuesFromAsset(asset: AssetRecord | null, defaultUnitId: string): AssetFormValues {
  return {
    unitId: asset?.unit_id ?? defaultUnitId,
    patrimony: asset?.patrimony_number ?? "",
    description: asset?.description ?? "",
    notes: asset?.notes ?? "",
    roomId: asset?.room_id ?? "",
    personId: asset?.responsible_person_id ?? "",
    registrationDate: asset?.registration_date ?? "",
    ownerUnitId: asset?.owner_unit_id ?? "",
    located: asset?.located ?? "DESCONHECIDO",
    category: asset?.asset_category ?? "",
    techType: asset?.tech_type ?? "",
    opStatus: asset?.operational_status ?? "",
    removeLocation: false,
  };
}

export type ChangeKey =
  | "patrimony"
  | "description"
  | "notes"
  | "date"
  | "room"
  | "person"
  | "location"
  | "category"
  | "techType"
  | "opStatus"
  | "owner"
  | "located";

/** Rótulo de cada campo no resumo (mesmos textos dos rótulos do formulário). */
export const CHANGE_LABEL: Record<ChangeKey, string> = {
  patrimony: "Número patrimonial",
  description: "Descrição",
  notes: "Observações",
  date: "Data de registro",
  room: "Sala",
  person: "Responsável",
  location: "Local",
  category: "Categoria",
  techType: "Tipo de TI",
  opStatus: "Situação operacional",
  owner: "Unidade proprietária",
  located: "Localizado",
};

const normalizePatrimony = (value: string) => value.trim().replace(/\s+/g, " ");

export interface ChangeContext {
  /** `true` = edição (PATCH); na criação não há "alterado". */
  editing: boolean;
  hasNotes: boolean;
  isAdmin: boolean;
}

/** Campos do rascunho que diferem da base, na ordem do formulário. */
export function changedKeys(base: AssetFormValues, draft: AssetFormValues, ctx: ChangeContext): ChangeKey[] {
  if (!ctx.editing) return [];
  const keys: ChangeKey[] = [];
  if (ctx.isAdmin && normalizePatrimony(draft.patrimony) !== base.patrimony) keys.push("patrimony");
  if (draft.description.trim() !== base.description) keys.push("description");
  if (ctx.hasNotes && draft.notes.trim() !== base.notes) keys.push("notes");
  if (draft.registrationDate !== base.registrationDate) keys.push("date");
  if (draft.roomId !== base.roomId) keys.push("room");
  if (draft.personId !== base.personId) keys.push("person");
  if (draft.removeLocation) keys.push("location");
  if (draft.category !== base.category) keys.push("category");
  if (draft.techType !== base.techType) keys.push("techType");
  if (draft.opStatus !== base.opStatus) keys.push("opStatus");
  if (ctx.isAdmin && draft.ownerUnitId !== base.ownerUnitId) keys.push("owner");
  if (ctx.isAdmin && draft.located !== base.located) keys.push("located");
  return keys;
}

/** Corpo do PATCH: SÓ os campos alterados + `version` (contrato inalterado). */
export function buildPatch(draft: AssetFormValues, keys: readonly ChangeKey[], version: number): UpdateAssetRequest {
  const body: UpdateAssetRequest = { version };
  for (const key of keys) {
    if (key === "patrimony") body.patrimony_number = draft.patrimony.trim();
    else if (key === "description") body.description = blankToNull(draft.description);
    else if (key === "notes") body.notes = blankToNull(draft.notes);
    else if (key === "date") body.registration_date = draft.registrationDate || null;
    else if (key === "room") body.room_id = draft.roomId || null;
    else if (key === "person") body.responsible_person_id = draft.personId || null;
    else if (key === "location") body.location_id = null;
    else if (key === "category") body.asset_category = draft.category || null;
    else if (key === "techType") body.tech_type = draft.techType || null;
    else if (key === "opStatus") body.operational_status = draft.opStatus || null;
    else if (key === "owner") body.owner_unit_id = draft.ownerUnitId || null;
    else if (key === "located") body.located = draft.located;
  }
  return body;
}

export interface NamedOption {
  id: string;
  name: string;
}

export interface DisplayLookups {
  rooms: readonly NamedOption[];
  people: readonly NamedOption[];
  units: readonly { id: string; code: string; name: string }[];
  /** Local atual do bem (só pode ser mantido ou removido). */
  currentLocation: string | null;
}

const SUMMARY_TEXT_MAX = 80;

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > SUMMARY_TEXT_MAX ? `${flat.slice(0, SUMMARY_TEXT_MAX)}…` : flat;
}

/** Valor legível de um campo do rascunho (texto puro; React escapa). */
export function displayValue(key: ChangeKey, values: AssetFormValues, lookups: DisplayLookups): string {
  switch (key) {
    case "patrimony":
      return values.patrimony.trim().replace(/\s+/g, " ") || "—";
    case "description":
      return values.description.trim() ? clip(values.description) : "—";
    case "notes":
      return values.notes.trim() ? clip(values.notes) : "—";
    case "date":
      return formatCalendarDate(values.registrationDate) ?? "—";
    case "room":
      return lookups.rooms.find((room) => room.id === values.roomId)?.name ?? "Nenhuma";
    case "person":
      return lookups.people.find((person) => person.id === values.personId)?.name ?? "Nenhum";
    case "location":
      return values.removeLocation ? "Removido" : (lookups.currentLocation ?? "—");
    case "category":
      return classificationLabel(CATEGORY_LABEL, values.category);
    case "techType":
      return classificationLabel(TECH_TYPE_LABEL, values.techType);
    case "opStatus":
      return classificationLabel(OPERATIONAL_STATUS_LABEL, values.opStatus);
    case "owner": {
      const unit = lookups.units.find((candidate) => candidate.id === values.ownerUnitId);
      return unit ? unitRefText(unit) : "Nenhuma";
    }
    case "located":
      return LOCATED_LABEL[values.located];
  }
}

/** Valor do campo no RESPOSTA do servidor (para o aviso de conflito). */
export function displayServerValue(key: ChangeKey, server: AssetRecord, lookups: DisplayLookups): string {
  const values = valuesFromAsset(server, "");
  if (key === "room") return server.room?.name ?? "Nenhuma";
  if (key === "person") return server.responsible_person?.name ?? "Nenhum";
  if (key === "owner") return server.owner_unit ? unitRefText(server.owner_unit) : "Nenhuma";
  if (key === "location") return server.location?.name ?? "—";
  return displayValue(key, values, lookups);
}

/** Campos que o usuário alterou e que o servidor também mudou (valor diferente do rascunho). */
export function divergentKeys(
  initial: AssetFormValues,
  draft: AssetFormValues,
  server: AssetFormValues,
  ctx: ChangeContext,
): ChangeKey[] {
  const mine = new Set(changedKeys(initial, draft, ctx));
  const theirs = new Set(changedKeys(initial, server, ctx));
  const diverging = new Set(changedKeys(server, draft, ctx));
  return changedKeys(initial, draft, ctx).filter((key) => mine.has(key) && theirs.has(key) && diverging.has(key));
}

/**
 * Rascunho depois de recarregar o servidor: o que o usuário mexeu é mantido; o
 * resto acompanha o servidor (assim o formulário nunca mostra dado velho como atual).
 */
export function mergeDraft(
  initial: AssetFormValues,
  draft: AssetFormValues,
  server: AssetFormValues,
  ctx: ChangeContext,
): AssetFormValues {
  const touched = new Set(changedKeys(initial, draft, ctx));
  const keep = <K extends keyof AssetFormValues>(key: ChangeKey, field: K): AssetFormValues[K] =>
    touched.has(key) ? draft[field] : server[field];
  return {
    unitId: server.unitId,
    patrimony: keep("patrimony", "patrimony"),
    description: keep("description", "description"),
    notes: keep("notes", "notes"),
    registrationDate: keep("date", "registrationDate"),
    roomId: keep("room", "roomId"),
    personId: keep("person", "personId"),
    removeLocation: touched.has("location") ? draft.removeLocation : false,
    category: keep("category", "category"),
    techType: keep("techType", "techType"),
    opStatus: keep("opStatus", "opStatus"),
    ownerUnitId: keep("owner", "ownerUnitId"),
    located: keep("located", "located"),
  };
}
