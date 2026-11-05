import { tr } from "@/lib/i18n";
import { z } from "zod";
import { floorPlanLoadSchema } from "@/domain/floor-plan/schema";
import type { FloorPlan } from "@/domain/floor-plan/types";

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export const PROJECT_PREFIX = "spaceplan-ai:project:";
export const ACTIVE_PROJECT_KEY = "spaceplan-ai:active-project:v1";
export const MAX_PLAN_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Migration is in memory only; a normal successful save upgrades the record.
 * Formats 1–5 are brought to 6 here, then each format to the next, up to the current one.
 */
function toVersionSix(value: unknown): unknown {
  if (
    typeof value === "object" && value !== null &&
    "schemaVersion" in value &&
    (value.schemaVersion === 1 || value.schemaVersion === 2 ||
      value.schemaVersion === 3 || value.schemaVersion === 4) &&
    "openings" in value && Array.isArray(value.openings) &&
    value.openings.some((opening: unknown) =>
      typeof opening === "object" && opening !== null && "door" in opening)
  ) {
    // Door orientation did not exist in these formats. Do not bless injected
    // fields by changing the version before validating the legacy shape.
    return value;
  }
  // Requirements arrived in v6; an older file that already carries them is not
  // migrated, so its injected field fails validation instead of being blessed.
  if (typeof value === "object" && value !== null && "requirements" in value) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    !("roomMode" in value) &&
    !("wallRoomLabels" in value) &&
    (value.schemaVersion !== 1 || !("underlay" in value))
  ) {
    return { ...value, schemaVersion: 6, roomMode: "manual", wallRoomLabels: [], requirements: [] };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 3 &&
    !("wallRoomLabels" in value)
  ) {
    return { ...value, schemaVersion: 6, wallRoomLabels: [], requirements: [] };
  }
  if (
    typeof value === "object" && value !== null &&
    "schemaVersion" in value && (value.schemaVersion === 4 || value.schemaVersion === 5)
  ) {
    return { ...value, schemaVersion: 6, requirements: [] };
  }
  return value;
}

/**
 * 6 → 7 only adds optional things: a wall type (absent means unknown), the
 * "bearing walls kept" requirement and the origin of a variant. Nothing is rewritten.
 * A version-6 file that already carries one of them is not migrated, so its injected
 * field fails validation instead of being blessed.
 */
function toVersionSeven(value: unknown): unknown {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 6 ||
    "origin" in value
  ) return value;
  const { walls, requirements } = value as { walls?: unknown; requirements?: unknown };
  const has = (items: unknown, test: (item: object) => boolean) =>
    Array.isArray(items) && items.some((item) => typeof item === "object" && item !== null && test(item));
  if (has(walls, (wall) => "kind" in wall)) return value;
  if (has(requirements, (item) => "type" in item && item.type === "bearing-walls-kept")) return value;
  return { ...value, schemaVersion: 7 };
}

/** A v7 file that already carries the v8 field is refused rather than blessed. */
function toVersionEight(value: unknown): unknown {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 7 ||
    "buildingFacts" in value
  ) return value;
  return { ...value, schemaVersion: 8 };
}

/** Anything format 9 added, in the plan or in the snapshot a variant carries. */
function usesVersionNine(plan: Record<string, unknown>): boolean {
  const items = (key: string) => (Array.isArray(plan[key]) ? (plan[key] as unknown[]) : []);
  const hasNewKind = (item: unknown) =>
    typeof item === "object" && item !== null && "kind" in item && (item.kind === "balcony" || item.kind === "shaft");
  const facts = plan.buildingFacts;
  const origin = plan.origin;
  return (
    items("rooms").some(hasNewKind) ||
    items("wallRoomLabels").some(hasNewKind) ||
    items("openings").some((item) => typeof item === "object" && item !== null && "doorless" in item) ||
    (typeof facts === "object" && facts !== null && "floorLevel" in facts) ||
    (typeof origin === "object" && origin !== null && "snapshot" in origin &&
      typeof origin.snapshot === "object" && origin.snapshot !== null &&
      usesVersionNine(origin.snapshot as Record<string, unknown>))
  );
}

/** A v8 file that already carries v9 content is refused rather than blessed. */
function toVersionNine(value: unknown): unknown {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 8 ||
    usesVersionNine(value as Record<string, unknown>)
  ) return value;
  return { ...value, schemaVersion: 9 };
}

/** A v9 file that already carries the v10 field is refused rather than blessed. */
function toVersionTen(value: unknown): unknown {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 9 ||
    "ruleProfile" in value
  ) return value;
  return { ...value, schemaVersion: 10 };
}

/** Fields format 11 added. A v10 file that carries one of them is refused rather than blessed. */
const VERSION_ELEVEN_FIELDS = ["recognition", "template", "purchase"];

function toCurrentVersion(value: unknown): unknown {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 10 ||
    VERSION_ELEVEN_FIELDS.some((field) => field in value)
  ) return value;
  return { ...value, schemaVersion: 11 };
}

const persistedPlanSchema = z.preprocess(
  (value) => toCurrentVersion(toVersionTen(toVersionNine(toVersionEight(toVersionSeven(toVersionSix(value)))))),
  floorPlanLoadSchema,
);

const recordFields = {
  revision: z.string().min(1).max(100),
  updatedAt: z.string().datetime(),
  plan: persistedPlanSchema,
};
const activeRecordSchema = z
  .object({
    storageVersion: z.literal(1),
    ...recordFields,
  })
  .strict();
const trashedRecordSchema = z
  .object({
    storageVersion: z.literal(2),
    ...recordFields,
    trashedAt: z.string().datetime(),
  })
  .strict();
const recordSchema = z.discriminatedUnion("storageVersion", [
  activeRecordSchema,
  trashedRecordSchema,
]);
const projectNameSchema = z
  .string()
  .trim()
  .min(1, tr`Введите название проекта.`)
  .max(100, tr`Название проекта — не больше 100 символов.`);
export type SavedProject = z.infer<typeof activeRecordSchema>;
export type TrashedProject = z.infer<typeof trashedRecordSchema>;
type StoredProject = SavedProject | TrashedProject;

export class ProjectConflictError extends Error {
  constructor(
    message =
      tr`Проект изменён в другой вкладке. Сохраните свою версию как копию или загрузите сохранённую.`,
  ) {
    super(message);
    this.name = "ProjectConflictError";
  }
}

export class ProjectTrashedError extends ProjectConflictError {
  constructor() {
    super(
      tr`Проект находится в корзине. Восстановите его в библиотеке или сохраните открытую версию как копию.`,
    );
    this.name = "ProjectTrashedError";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      tr`Не удалось прочитать JSON. Проверьте файл и попробуйте снова.`,
    );
  }
}

function validatePlan(value: unknown): FloorPlan {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1 &&
    value.schemaVersion !== 2 &&
    value.schemaVersion !== 3 &&
    value.schemaVersion !== 4 &&
    value.schemaVersion !== 5 &&
    value.schemaVersion !== 6 &&
    value.schemaVersion !== 7 &&
    value.schemaVersion !== 8 &&
    value.schemaVersion !== 9 &&
    value.schemaVersion !== 10 &&
    value.schemaVersion !== 11
  ) {
    throw new Error(
      tr`Версия формата не поддерживается. Нужен план SpacePlan версии от 1 до 11.`,
    );
  }
  const result = persistedPlanSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues.find((item) => item.code === "custom");
    throw new Error(
      issue?.message ??
        tr`Некорректный план: проверьте поля, единицы измерения, размеры и координаты.`,
    );
  }
  return result.data;
}

export function parsePlanFile(text: string): FloorPlan {
  if (new TextEncoder().encode(text).byteLength > MAX_PLAN_FILE_BYTES)
    throw new Error(tr`Файл слишком большой. Максимальный размер — 4 МБ.`);
  return validatePlan(parseJson(text.replace(/^\uFEFF/, "")));
}

export function serializePlan(plan: FloorPlan): string {
  const validated = validatePlan(plan);
  const readable = JSON.stringify(validated, null, 2) + "\n";
  // Formatting must not make an accepted backup too large to import again.
  return new TextEncoder().encode(readable).byteLength <= MAX_PLAN_FILE_BYTES
    ? readable
    : JSON.stringify(validated);
}

export function makeExportFilename(name: string): string {
  const safe = Array.from(name.trim(), (char) =>
    char.charCodeAt(0) < 32 ? "-" : char,
  )
    .join("")
    .replace(/[<>:"/\\|?*]/g, "-")
    .slice(0, 80)
    .replace(/[. ]+$/g, "");
  const base = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)
    ? tr`Проект-${safe}`
    : safe;
  return `${base || "SpacePlan"}.spaceplan.json`;
}

function readStoredProject(
  storage: StorageLike,
  id: string,
): StoredProject | null {
  const raw = storage.getItem(PROJECT_PREFIX + id);
  if (raw === null) return null;
  const parsed = recordSchema.safeParse(parseJson(raw));
  if (!parsed.success || parsed.data.plan.id !== id)
    throw new Error(
      tr`Сохранённый проект повреждён или имеет неподдерживаемый формат. Исходная запись оставлена без изменений.`,
    );
  return parsed.data;
}

export function readProject(
  storage: StorageLike,
  id: string,
): SavedProject | null {
  const record = readStoredProject(storage, id);
  return record?.storageVersion === 1 ? record : null;
}

export function readTrashedProject(
  storage: StorageLike,
  id: string,
): TrashedProject | null {
  const record = readStoredProject(storage, id);
  return record?.storageVersion === 2 ? record : null;
}

export function listProjects(storage: StorageLike): {
  projects: SavedProject[];
  trash: TrashedProject[];
  unreadableCount: number;
} {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(PROJECT_PREFIX)) keys.push(key);
  }
  const projects: SavedProject[] = [];
  const trash: TrashedProject[] = [];
  let unreadableCount = 0;
  for (const key of keys) {
    try {
      const saved = readStoredProject(storage, key.slice(PROJECT_PREFIX.length));
      if (saved?.storageVersion === 1) projects.push(saved);
      if (saved?.storageVersion === 2) trash.push(saved);
    } catch {
      unreadableCount++;
    }
  }
  projects.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.plan.id.localeCompare(b.plan.id),
  );
  trash.sort(
    (a, b) =>
      b.trashedAt.localeCompare(a.trashedAt) ||
      a.plan.id.localeCompare(b.plan.id),
  );
  return { projects, trash, unreadableCount };
}

/** Records that cannot be read, exactly as stored, so that nothing is lost with them. */
export function readUnreadableRecords(storage: StorageLike): { key: string; raw: string }[] {
  const records: { key: string; raw: string }[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(PROJECT_PREFIX)) continue;
    try {
      readStoredProject(storage, key.slice(PROJECT_PREFIX.length));
    } catch {
      records.push({ key, raw: storage.getItem(key) ?? "" });
    }
  }
  return records;
}

function writeRecord(storage: StorageLike, record: StoredProject): void {
  // One write to the same key preserves both the previous record on failure and
  // the tombstone needed to stop stale tabs from resurrecting a trashed project.
  storage.setItem(PROJECT_PREFIX + record.plan.id, JSON.stringify(record));
}

function requireActiveProject(
  storage: StorageLike,
  id: string,
  expectedRevision: string,
): SavedProject {
  const record = readStoredProject(storage, id);
  if (record?.storageVersion === 2) throw new ProjectTrashedError();
  if (!record || record.revision !== expectedRevision)
    throw new ProjectConflictError();
  return record;
}

/** The caller serializes cooperating browser tabs with a Web Lock. */
export function saveProject(
  storage: StorageLike,
  plan: FloorPlan,
  expectedRevision: string | null,
  revision: string,
  updatedAt: string,
): SavedProject {
  const validated = validatePlan(plan);
  const existing = readStoredProject(storage, validated.id);
  if (existing?.storageVersion === 2) throw new ProjectTrashedError();
  if ((existing?.revision ?? null) !== expectedRevision)
    throw new ProjectConflictError();
  const record = activeRecordSchema.parse({
    storageVersion: 1,
    revision,
    updatedAt,
    plan: validated,
  });
  writeRecord(storage, record);
  return record;
}

/** Like saving, library mutations must run under the project's browser Web Lock. */
export function renameProject(
  storage: StorageLike,
  id: string,
  name: string,
  expectedRevision: string,
  revision: string,
  updatedAt: string,
): SavedProject {
  const existing = requireActiveProject(storage, id, expectedRevision);
  const validatedName = projectNameSchema.parse(name);
  if (validatedName === existing.plan.name) return existing;
  const record = activeRecordSchema.parse({
    storageVersion: 1,
    revision,
    updatedAt,
    plan: { ...existing.plan, name: validatedName },
  });
  writeRecord(storage, record);
  return record;
}

export function trashProject(
  storage: StorageLike,
  id: string,
  expectedRevision: string,
  revision: string,
  trashedAt: string,
): TrashedProject {
  const existing = requireActiveProject(storage, id, expectedRevision);
  const record = trashedRecordSchema.parse({
    ...existing,
    storageVersion: 2,
    revision,
    trashedAt,
  });
  writeRecord(storage, record);
  return record;
}

export function restoreProject(
  storage: StorageLike,
  id: string,
  expectedRevision: string,
  revision: string,
  updatedAt: string,
): SavedProject {
  const existing = readStoredProject(storage, id);
  if (
    !existing ||
    existing.storageVersion !== 2 ||
    existing.revision !== expectedRevision
  )
    throw new ProjectConflictError(
      tr`Проект в корзине изменён или уже восстановлен. Обновите библиотеку и попробуйте снова.`,
    );
  const record = activeRecordSchema.parse({
    storageVersion: 1,
    revision,
    updatedAt,
    plan: existing.plan,
  });
  writeRecord(storage, record);
  return record;
}
