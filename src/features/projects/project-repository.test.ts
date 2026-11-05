import { describe, expect, it, vi } from "vitest";
import {
  createEmptyPlan,
  createExamplePlan,
} from "@/domain/floor-plan/operations";
import {
  listProjects,
  makeExportFilename,
  MAX_PLAN_FILE_BYTES,
  parsePlanFile,
  PROJECT_PREFIX,
  ProjectConflictError,
  ProjectTrashedError,
  readProject,
  readTrashedProject,
  renameProject,
  restoreProject,
  saveProject,
  serializePlan,
  trashProject,
} from "./project-repository";
import { MemoryStorage } from "./project-test-helpers";
import type { FloorPlan } from "@/domain/floor-plan/types";
const now = "2026-10-19T00:00:00.000Z";

function legacyExample(schemaVersion: 1 | 2) {
  const plan = createExamplePlan();
  return {
    schemaVersion,
    unit: plan.unit,
    id: plan.id,
    name: plan.name,
    rooms: plan.rooms,
    walls: plan.walls,
    openings: plan.openings,
  };
}

function legacyWallPlan() {
  const plan = labelledWallPlan();
  return {
    schemaVersion: 3,
    unit: plan.unit,
    id: plan.id,
    name: plan.name,
    roomMode: plan.roomMode,
    rooms: plan.rooms,
    walls: plan.walls,
    openings: plan.openings,
  };
}

function labelledWallPlan(): FloorPlan {
  const corners = [
    { x: 0, y: 0 }, { x: 5, y: 0 },
    { x: 5, y: 4 }, { x: 0, y: 4 },
  ];
  const walls = corners.map((start, index) => ({
    id: `wall-${index}`, start, end: corners[(index + 1) % corners.length],
    thickness: 0.2, height: 2.7,
  }));
  return {
    ...createEmptyPlan("labelled"),
    roomMode: "walls",
    walls,
    openings: [{
      id: "door", wallId: walls[0].id, kind: "door", offset: 0.5,
      width: 0.9, height: 2.1, sillHeight: 0,
    }],
    wallRoomLabels: [{
      id: "label-bedroom", name: "Спальня", kind: "bedroom", color: "#aabbcc",
      anchor: { x: 2.5, y: 2 }, boundaryWallIds: walls.map((wall) => wall.id),
    }],
  };
}

/** A real v4/v5 file has no `requirements`; those arrived in v6. */
function withoutRequirements(plan: FloorPlan): Omit<FloorPlan, "requirements"> {
  const copy: Partial<FloorPlan> = { ...plan };
  delete copy.requirements;
  return copy as Omit<FloorPlan, "requirements">;
}

function legacyLabelledPlan() {
  return {
    ...withoutRequirements(labelledWallPlan()),
    schemaVersion: 4,
    underlay: {
      name: "Исходный план.png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
      pixelWidth: 1000, pixelHeight: 500, x: -2, y: -1,
      metersPerPixel: 0.02, opacity: 0.6, visible: true, calibrated: true,
    },
  };
}

describe("project repository", () => {
  it.each([1, 2] as const)(
    "reads version %i records without modifying them and upgrades on the next successful save",
    (version) => {
      const storage = new MemoryStorage();
      const oldPlan = legacyExample(version);
      const raw = JSON.stringify({
        storageVersion: 1,
        revision: "legacy-r1",
        updatedAt: now,
        plan: oldPlan,
      });
      storage.setItem(PROJECT_PREFIX + oldPlan.id, raw);
      const restored = readProject(storage, oldPlan.id)!;
      expect(restored.plan).toEqual({
        ...oldPlan,
        schemaVersion: 11,
        roomMode: "manual",
        wallRoomLabels: [],
        requirements: [],
      });
      expect(restored.plan).not.toHaveProperty("underlay");
      expect(listProjects(storage).unreadableCount).toBe(0);
      expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
      storage.failWrites = true;
      expect(() =>
        saveProject(storage, restored.plan, "legacy-r1", "r2", now),
      ).toThrow();
      expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
      storage.failWrites = false;
      saveProject(storage, restored.plan, "legacy-r1", "r2", now);
      expect(readProject(storage, oldPlan.id)!.plan.schemaVersion).toBe(11);
      expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toContain(
        '"schemaVersion":11',
      );
    },
  );
  it("migrates version 3 wall mode only in memory and preserves its geometry and openings", () => {
    const storage = new MemoryStorage();
    const oldPlan = legacyWallPlan();
    const raw = JSON.stringify({
      storageVersion: 1, revision: "legacy-v3", updatedAt: now, plan: oldPlan,
    });
    storage.setItem(PROJECT_PREFIX + oldPlan.id, raw);
    const restored = readProject(storage, oldPlan.id)!;
    expect(restored.plan).toEqual({ ...oldPlan, schemaVersion: 11, wallRoomLabels: [], requirements: [] });
    expect(listProjects(storage).projects[0].plan).toEqual(restored.plan);
    expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
    storage.failWrites = true;
    expect(() => saveProject(storage, restored.plan, "legacy-v3", "new", now)).toThrow();
    expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
    storage.failWrites = false;
    saveProject(storage, restored.plan, "legacy-v3", "new", now);
    expect(JSON.parse(storage.getItem(PROJECT_PREFIX + oldPlan.id)!).plan).toEqual(restored.plan);
  });
  it("reads version 4 labels, geometry and calibrated underlay unchanged, and upgrades only on a successful save", () => {
    const storage = new MemoryStorage();
    const oldPlan = legacyLabelledPlan();
    const key = PROJECT_PREFIX + oldPlan.id;
    const raw = JSON.stringify({ storageVersion: 1, revision: "legacy-v4", updatedAt: now, plan: oldPlan });
    storage.setItem(key, raw);
    const write = vi.spyOn(storage, "setItem");
    const migrated = { ...oldPlan, schemaVersion: 11, requirements: [] };
    expect(readProject(storage, oldPlan.id)!.plan).toEqual(migrated);
    expect(listProjects(storage).projects[0].plan).toEqual(migrated);
    const unchanged = renameProject(storage, oldPlan.id, ` ${oldPlan.name} `, "legacy-v4", "unused", now);
    expect(unchanged.revision).toBe("legacy-v4");
    expect(unchanged.plan).toEqual(migrated);
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(raw);
    storage.failWrites = true;
    expect(() => saveProject(storage, unchanged.plan, "legacy-v4", "failed", now)).toThrow();
    expect(storage.getItem(key)).toBe(raw);
    storage.failWrites = false;
    saveProject(storage, unchanged.plan, "legacy-v4", "current", now);
    expect(JSON.parse(storage.getItem(key)!).plan).toEqual(migrated);
    expect(readProject(storage, oldPlan.id)!.plan.openings[0]).not.toHaveProperty("door");
  });
  it("atomically saves and updates with revisions", () => {
    const storage = new MemoryStorage(),
      plan = createExamplePlan();
    const first = saveProject(storage, plan, null, "r1", now);
    expect(readProject(storage, plan.id)).toEqual(first);
    expect(
      saveProject(storage, { ...plan, name: "Renamed" }, "r1", "r2", now).plan
        .name,
    ).toBe("Renamed");
  });
  it("rejects stale writers without changing stored data", () => {
    const storage = new MemoryStorage(),
      plan = createExamplePlan();
    saveProject(storage, plan, null, "r1", now);
    const before = storage.getItem(PROJECT_PREFIX + plan.id);
    expect(() => saveProject(storage, plan, null, "r2", now)).toThrow(
      ProjectConflictError,
    );
    expect(() => saveProject(storage, plan, "stale", "r2", now)).toThrow(
      ProjectConflictError,
    );
    expect(storage.getItem(PROJECT_PREFIX + plan.id)).toBe(before);
  });
  it("leaves the prior version intact on quota errors or invalid plans", () => {
    const storage = new MemoryStorage(),
      plan = createExamplePlan();
    saveProject(storage, plan, null, "r1", now);
    const before = storage.getItem(PROJECT_PREFIX + plan.id);
    storage.failWrites = true;
    expect(() =>
      saveProject(storage, { ...plan, name: "Change" }, "r1", "r2", now),
    ).toThrow();
    storage.failWrites = false;
    expect(() =>
      saveProject(
        storage,
        { ...plan, rooms: [...plan.rooms, plan.rooms[0]] },
        "r1",
        "r2",
        now,
      ),
    ).toThrow();
    expect(storage.getItem(PROJECT_PREFIX + plan.id)).toBe(before);
  });
  it("isolates unreadable records and ignores other applications' keys", () => {
    const storage = new MemoryStorage();
    saveProject(storage, createEmptyPlan("a"), null, "r1", now);
    saveProject(
      storage,
      createEmptyPlan("b"),
      null,
      "r2",
      "2026-10-20T00:00:00.000Z",
    );
    storage.setItem("another-app", "not JSON");
    storage.setItem(PROJECT_PREFIX + "broken", "{");
    storage.setItem(
      PROJECT_PREFIX + "unknown",
      JSON.stringify({ storageVersion: 2 }),
    );
    const library = listProjects(storage);
    expect(library.projects.map((saved) => saved.plan.id)).toEqual(["b", "a"]);
    expect(library.unreadableCount).toBe(2);
    expect(storage.getItem(PROJECT_PREFIX + "broken")).toBe("{");
    expect(() =>
      saveProject(storage, createEmptyPlan("broken"), null, "new", now),
    ).toThrow();
  });
  it("rejects mismatched record identity", () => {
    const storage = new MemoryStorage();
    const saved = saveProject(storage, createEmptyPlan("a"), null, "r1", now);
    storage.setItem(PROJECT_PREFIX + "b", JSON.stringify(saved));
    expect(() => readProject(storage, "b")).toThrow();
  });
  it("keeps saved labels intact during a stale write or quota failure", () => {
    const storage = new MemoryStorage();
    const plan = labelledWallPlan();
    saveProject(storage, plan, null, "r1", now);
    const raw = storage.getItem(PROJECT_PREFIX + plan.id);
    const changed = {
      ...plan,
      wallRoomLabels: [{ ...plan.wallRoomLabels[0], name: "Кабинет", color: "#123456" }],
    };
    expect(() => saveProject(storage, changed, "old", "r2", now)).toThrow(ProjectConflictError);
    expect(storage.getItem(PROJECT_PREFIX + plan.id)).toBe(raw);
    storage.failWrites = true;
    expect(() => saveProject(storage, changed, "r1", "r2", now)).toThrow();
    expect(storage.getItem(PROJECT_PREFIX + plan.id)).toBe(raw);
    expect(readProject(storage, plan.id)!.plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
    storage.failWrites = false;
    saveProject(storage, changed, "r1", "r2", now);
    expect(readProject(storage, plan.id)!.plan.wallRoomLabels).toEqual(changed.wallRoomLabels);
  });
});

describe("project names and recoverable trash", () => {
  const later = "2026-10-24T12:00:00.000Z";

  function savedExample() {
    const storage = new MemoryStorage();
    const plan = labelledWallPlan();
    const saved = saveProject(storage, plan, null, "active-r1", now);
    return { storage, plan, saved, key: PROJECT_PREFIX + plan.id };
  }

  it("renames only the project name, trims surrounding whitespace and updates its revision", () => {
    const { storage, plan } = savedExample();
    const renamed = renameProject(storage, plan.id, "  Дом у озера \n", "active-r1", "renamed-r2", later);
    expect(renamed).toEqual({
      storageVersion: 1, revision: "renamed-r2", updatedAt: later,
      plan: { ...plan, name: "Дом у озера" },
    });
    expect(readProject(storage, plan.id)).toEqual(renamed);
    expect(storage.length).toBe(1);
  });

  it("accepts exactly 100 trimmed characters and leaves the original record after invalid names", () => {
    const { storage, plan, key } = savedExample();
    const before = storage.getItem(key);
    for (const name of ["", " \n\t ", "я".repeat(101)]) {
      expect(() => renameProject(storage, plan.id, name, "active-r1", "next", later)).toThrow();
      expect(storage.getItem(key)).toBe(before);
    }
    expect(renameProject(storage, plan.id, ` ${"я".repeat(100)} `, "active-r1", "next", later).plan.name).toBe("я".repeat(100));
  });

  it("does not write or upgrade a legacy record for a no-op rename, but still checks the revision", () => {
    const storage = new MemoryStorage();
    const plan = legacyWallPlan();
    const raw = JSON.stringify({ storageVersion: 1, revision: "legacy", updatedAt: now, plan });
    const key = PROJECT_PREFIX + plan.id;
    storage.setItem(key, raw);
    const write = vi.spyOn(storage, "setItem");
    const unchanged = renameProject(storage, plan.id, ` ${plan.name} `, "legacy", "new", later);
    expect(unchanged.revision).toBe("legacy");
    expect(unchanged.updatedAt).toBe(now);
    expect(unchanged.plan.schemaVersion).toBe(11);
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(raw);
    expect(() => renameProject(storage, plan.id, plan.name, "stale", "new", later)).toThrow(ProjectConflictError);
    expect(write).not.toHaveBeenCalled();
  });

  it("moves a complete project to trash and restores the same ID and content with one write each", () => {
    const { storage, plan, key } = savedExample();
    const write = vi.spyOn(storage, "setItem");
    const remove = vi.spyOn(storage, "removeItem");
    const trashed = trashProject(storage, plan.id, "active-r1", "trash-r2", later);
    expect(trashed).toEqual({
      storageVersion: 2, revision: "trash-r2", updatedAt: now, trashedAt: later, plan,
    });
    expect(readProject(storage, plan.id)).toBeNull();
    expect(readTrashedProject(storage, plan.id)).toEqual(trashed);
    expect(listProjects(storage)).toEqual({ projects: [], trash: [trashed], unreadableCount: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(key);
    const restored = restoreProject(storage, plan.id, "trash-r2", "restored-r3", later);
    expect(restored).toEqual({ storageVersion: 1, revision: "restored-r3", updatedAt: later, plan });
    expect(readProject(storage, plan.id)).toEqual(restored);
    expect(readTrashedProject(storage, plan.id)).toBeNull();
    expect(listProjects(storage)).toEqual({ projects: [restored], trash: [], unreadableCount: 0 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toBe(key);
    expect(remove).not.toHaveBeenCalled();
    expect(storage.length).toBe(1);
  });

  it("orders trash by deletion time and keeps active projects separate", () => {
    const storage = new MemoryStorage();
    saveProject(storage, createEmptyPlan("active"), null, "active", later);
    for (const id of ["a", "b", "c"]) saveProject(storage, createEmptyPlan(id), null, `${id}-1`, now);
    trashProject(storage, "a", "a-1", "a-2", later);
    trashProject(storage, "c", "c-1", "c-2", now);
    trashProject(storage, "b", "b-1", "b-2", later);
    const result = listProjects(storage);
    expect(result.projects.map((record) => record.plan.id)).toEqual(["active"]);
    expect(result.trash.map((record) => record.plan.id)).toEqual(["a", "b", "c"]);
    expect(result.unreadableCount).toBe(0);
  });

  it("refuses stale, missing and wrong-state library mutations without writing", () => {
    const { storage, plan, key } = savedExample();
    const write = vi.spyOn(storage, "setItem");
    const original = storage.getItem(key);
    for (const id of [plan.id, "missing"]) {
      expect(() => renameProject(storage, id, "Новое имя", "stale", "next", later)).toThrow(ProjectConflictError);
      expect(() => trashProject(storage, id, "stale", "next", later)).toThrow(ProjectConflictError);
      expect(() => restoreProject(storage, id, "active-r1", "next", later)).toThrow(ProjectConflictError);
    }
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(original);
    trashProject(storage, plan.id, "active-r1", "trash-r2", later);
    const tombstone = storage.getItem(key);
    write.mockClear();
    expect(() => renameProject(storage, plan.id, "Новое имя", "trash-r2", "next", later)).toThrow(ProjectTrashedError);
    expect(() => trashProject(storage, plan.id, "trash-r2", "next", later)).toThrow(ProjectTrashedError);
    expect(() => restoreProject(storage, plan.id, "active-r1", "next", later)).toThrow(ProjectConflictError);
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(tombstone);
  });

  it("blocks stale saves from resurrecting trash even with its current revision or an expected empty key", () => {
    const { storage, plan, key } = savedExample();
    trashProject(storage, plan.id, "active-r1", "trash-r2", later);
    const tombstone = storage.getItem(key);
    const write = vi.spyOn(storage, "setItem");
    for (const expected of [null, "active-r1", "trash-r2"]) {
      expect(() => saveProject(storage, { ...plan, name: "Stale tab" }, expected, "resurrected", later)).toThrow(ProjectTrashedError);
      expect(() => saveProject(storage, plan, expected, "resurrected", later)).toThrow(ProjectConflictError);
    }
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(tombstone);
    restoreProject(storage, plan.id, "trash-r2", "restored-r3", later);
    const restored = storage.getItem(key);
    expect(() => saveProject(storage, plan, "active-r1", "stale", later)).toThrow(ProjectConflictError);
    expect(storage.getItem(key)).toBe(restored);
  });

  it.each(["rename", "trash", "restore"] as const)("preserves the previous record atomically after a %s quota error", (operation) => {
    const { storage, plan, key } = savedExample();
    if (operation === "restore") trashProject(storage, plan.id, "active-r1", "trash-r2", later);
    const before = storage.getItem(key);
    const remove = vi.spyOn(storage, "removeItem");
    storage.failWrites = true;
    expect(() => {
      if (operation === "rename") renameProject(storage, plan.id, "Переименовано", "active-r1", "next", later);
      else if (operation === "trash") trashProject(storage, plan.id, "active-r1", "next", later);
      else restoreProject(storage, plan.id, "trash-r2", "next", later);
    }).toThrow(/Quota/);
    expect(storage.getItem(key)).toBe(before);
    expect(storage.length).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4] as const)("reads a trashed version %i plan through migration without writing", (version) => {
    const storage = new MemoryStorage();
    const oldPlan = version === 4 ? legacyLabelledPlan() : version === 3 ? legacyWallPlan() : legacyExample(version);
    const key = PROJECT_PREFIX + oldPlan.id;
    const raw = JSON.stringify({ storageVersion: 2, revision: "legacy-trash", updatedAt: now, trashedAt: later, plan: oldPlan });
    storage.setItem(key, raw);
    const write = vi.spyOn(storage, "setItem");
    const record = readTrashedProject(storage, oldPlan.id)!;
    expect(record.plan.schemaVersion).toBe(11);
    expect(record.plan).toEqual({
      ...oldPlan, schemaVersion: 11, requirements: [],
      wallRoomLabels: "wallRoomLabels" in oldPlan ? oldPlan.wallRoomLabels : [],
      roomMode: version >= 3 ? "walls" : "manual",
    });
    expect(readProject(storage, oldPlan.id)).toBeNull();
    expect(listProjects(storage).trash).toEqual([record]);
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(raw);
    restoreProject(storage, oldPlan.id, "legacy-trash", "restored", later);
    expect(readProject(storage, oldPlan.id)!.plan).toEqual(record.plan);
  });

  it.each([
    ["", later], ["x".repeat(101), later], ["revision", "not-a-date"], ["revision", "2026-02-30T00:00:00.000Z"],
  ])("validates new wrapper metadata before any mutation %#", (revision, timestamp) => {
    const { storage, plan, key } = savedExample();
    const before = storage.getItem(key);
    const write = vi.spyOn(storage, "setItem");
    expect(() => saveProject(storage, plan, "active-r1", revision, timestamp)).toThrow();
    expect(() => renameProject(storage, plan.id, "Новое имя", "active-r1", revision, timestamp)).toThrow();
    expect(() => trashProject(storage, plan.id, "active-r1", revision, timestamp)).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(before);
    trashProject(storage, plan.id, "active-r1", "trash-r2", later);
    const trashed = storage.getItem(key);
    write.mockClear();
    expect(() => restoreProject(storage, plan.id, "trash-r2", revision, timestamp)).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(trashed);
  });

  it.each(["json", "identity", "unknown", "missing-date", "extra-field"])("retains a corrupt %s record and refuses every overwrite", (corruption) => {
    const { storage, plan, key, saved } = savedExample();
    const badRecord = {
      ...saved,
      storageVersion: corruption === "unknown" ? 3 : 2,
      trashedAt: later,
      ...(corruption === "identity" ? { plan: { ...plan, id: "someone-else" } } : {}),
      ...(corruption === "extra-field" ? { unexpected: true } : {}),
    };
    const raw = corruption === "json" ? "{" : corruption === "missing-date"
      ? JSON.stringify({ ...badRecord, trashedAt: undefined }) : JSON.stringify(badRecord);
    storage.setItem(key, raw);
    const write = vi.spyOn(storage, "setItem");
    expect(() => readProject(storage, plan.id)).toThrow();
    expect(() => readTrashedProject(storage, plan.id)).toThrow();
    expect(listProjects(storage)).toEqual({ projects: [], trash: [], unreadableCount: 1 });
    expect(() => saveProject(storage, plan, "active-r1", "next", later)).toThrow();
    expect(() => renameProject(storage, plan.id, "Новое имя", "active-r1", "next", later)).toThrow();
    expect(() => trashProject(storage, plan.id, "active-r1", "next", later)).toThrow();
    expect(() => restoreProject(storage, plan.id, "active-r1", "next", later)).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(raw);
  });
});

describe("versioned JSON transfer", () => {
  it("migrates version 4 JSON without inventing door metadata or losing labels and raster data", () => {
    const old = legacyLabelledPlan();
    const migrated = parsePlanFile(JSON.stringify(old));
    expect(migrated).toEqual({ ...old, schemaVersion: 11, requirements: [] });
    expect(migrated.openings[0]).not.toHaveProperty("door");
    expect(JSON.parse(serializePlan(migrated))).toEqual(migrated);
  });
  it.each([1, 2, 3, 4] as const)("rejects orientation injected into version %i rather than accepting it during migration", (version) => {
    const geometry = labelledWallPlan();
    const old = version === 4 ? legacyLabelledPlan() : version === 3 ? legacyWallPlan() : {
      ...legacyExample(version), walls: geometry.walls, openings: geometry.openings,
    };
    const injected = {
      ...old,
      openings: old.openings.map((opening) => ({
        ...opening, door: { hinge: "end", side: "right" },
      })),
    };
    expect(() => parsePlanFile(JSON.stringify(injected))).toThrow();
    for (const storageVersion of [1, 2]) {
      const storage = new MemoryStorage();
      const key = PROJECT_PREFIX + old.id;
      const raw = JSON.stringify({
        storageVersion, revision: "injected", updatedAt: now, plan: injected,
        ...(storageVersion === 2 ? { trashedAt: now } : {}),
      });
      storage.setItem(key, raw);
      const write = vi.spyOn(storage, "setItem");
      expect(() => readProject(storage, old.id)).toThrow();
      expect(() => readTrashedProject(storage, old.id)).toThrow();
      expect(listProjects(storage)).toEqual({ projects: [], trash: [], unreadableCount: 1 });
      expect(write).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toBe(raw);
    }
  });
  it("roundtrips current door orientation through JSON, trash and restore without changing geometry", () => {
    const original = labelledWallPlan();
    const plan: FloorPlan = {
      ...original,
      openings: [{ ...original.openings[0], door: { hinge: "end", side: "right" } }],
    };
    expect(parsePlanFile(serializePlan(plan))).toEqual(plan);
    const storage = new MemoryStorage();
    saveProject(storage, plan, null, "r1", now);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
    expect(trashProject(storage, plan.id, "r1", "r2", now).plan).toEqual(plan);
    expect(readTrashedProject(storage, plan.id)!.plan).toEqual(plan);
    expect(restoreProject(storage, plan.id, "r2", "r3", now).plan).toEqual(plan);
    const key = PROJECT_PREFIX + plan.id;
    const raw = storage.getItem(key);
    const invalid: FloorPlan = {
      ...plan, openings: [{ ...plan.openings[0], kind: "window" }],
    };
    expect(() => parsePlanFile(JSON.stringify(invalid))).toThrow(/только для двери/);
    expect(() => saveProject(storage, invalid, "r3", "bad", now)).toThrow(/только для двери/);
    expect(storage.getItem(key)).toBe(raw);
    expect(original.openings[0]).not.toHaveProperty("door");
  });
  it.each([1, 2] as const)(
    "migrates version %i backups to manual mode and exports version 7",
    (version) => {
      const old = legacyExample(version);
      const migrated = parsePlanFile(JSON.stringify(old));
      expect(migrated).toEqual({
        ...old,
        schemaVersion: 11,
        roomMode: "manual",
        wallRoomLabels: [],
        requirements: [],
      });
      expect(JSON.parse(serializePlan(migrated)).schemaVersion).toBe(11);
      expect(() =>
        parsePlanFile(JSON.stringify({ ...old, underlay: null })),
      ).toThrow();
    },
  );
  it("keeps legacy format boundaries strict and refuses future plans", () => {
    expect(() =>
      parsePlanFile(JSON.stringify({ ...legacyExample(1), roomMode: "walls" })),
    ).toThrow();
    expect(() =>
      parsePlanFile(JSON.stringify({ ...legacyExample(2), roomMode: "walls" })),
    ).toThrow();
    expect(() =>
      parsePlanFile(
        JSON.stringify({ ...createExamplePlan(), schemaVersion: 12 }),
      ),
    ).toThrow(/версии от 1 до 11/);
    for (const old of [legacyExample(1), legacyExample(2), legacyWallPlan()]) {
      expect(() => parsePlanFile(JSON.stringify({ ...old, wallRoomLabels: [] }))).toThrow();
    }
  });
  it("keeps calibrated raster data with the portable plan", () => {
    const plan = {
      ...createEmptyPlan("raster"),
      underlay: {
        name: "Plan.png",
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
        pixelWidth: 1000,
        pixelHeight: 500,
        x: -2,
        y: -1,
        metersPerPixel: 0.02,
        opacity: 0.6,
        visible: true,
        calibrated: true,
      },
    };
    const storage = new MemoryStorage();
    saveProject(storage, plan, null, "r1", now);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
    expect(parsePlanFile(serializePlan(plan))).toEqual(plan);
    const legacy = { ...legacyExample(2), underlay: plan.underlay };
    expect(parsePlanFile(JSON.stringify(legacy))).toEqual({
      ...legacy,
      schemaVersion: 11,
      roomMode: "manual",
      wallRoomLabels: [],
      requirements: [],
    });
    expect(() =>
      parsePlanFile(JSON.stringify({ ...legacy, schemaVersion: 1 })),
    ).toThrow();
  });
  it("roundtrips wall-derived mode without serializing computed contours", () => {
    const plan = { ...createExamplePlan(), roomMode: "walls" as const };
    const exported = serializePlan(plan);
    expect(parsePlanFile(exported)).toEqual(plan);
    expect(JSON.parse(exported)).not.toHaveProperty("detectedRooms");
    const storage = new MemoryStorage();
    saveProject(storage, plan, null, "walls-r1", now);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
  });
  it("migrates version 3 JSON and exports explicit current metadata without derived contours", () => {
    const old = legacyWallPlan();
    const migrated = parsePlanFile(JSON.stringify(old));
    expect(migrated).toEqual({ ...old, schemaVersion: 11, wallRoomLabels: [], requirements: [] });
    expect(JSON.parse(serializePlan(migrated))).toEqual(migrated);
  });
  it("migrates version 5 to 6 with no requirements and roundtrips saved requirements", () => {
    const current = labelledWallPlan();
    const v5 = { ...withoutRequirements(current), schemaVersion: 5 };
    expect(parsePlanFile(JSON.stringify(v5))).toEqual(current);
    // An older file that already carries requirements is not blessed by migration.
    expect(() => parsePlanFile(JSON.stringify({ ...v5, requirements: [] }))).toThrow();
    const withRequirements: FloorPlan = {
      ...current,
      requirements: [
        { id: "req-area", type: "room-min-area", kind: "bedroom", minArea: 12.5 },
        { id: "req-door", type: "rooms-connected", kind: "bedroom", otherKind: "hall", byDoor: true },
        { id: "req-max", type: "room-max-area", kind: "bedroom", maxArea: 30, labelId: "label-bedroom" },
        { id: "req-wall", type: "wall-fixed", wallId: "wall-0", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness: 0.2 },
      ],
    };
    expect(parsePlanFile(serializePlan(withRequirements))).toEqual(withRequirements);
    const storage = new MemoryStorage();
    saveProject(storage, withRequirements, null, "req-r1", now);
    expect(readProject(storage, withRequirements.id)!.plan).toEqual(withRequirements);
    expect(() => parsePlanFile(JSON.stringify({
      ...withRequirements,
      requirements: [{ id: "bad", type: "room-min-area", kind: "bedroom", minArea: -1 }],
    }))).toThrow();
  });
  it("roundtrips labels in JSON, stored records and the project library", () => {
    const plan = labelledWallPlan();
    const exported = JSON.parse(serializePlan(plan));
    expect(exported).toEqual(plan);
    expect(exported).not.toHaveProperty("detectedRooms");
    expect(exported.wallRoomLabels[0]).not.toHaveProperty("outer");
    expect(parsePlanFile(JSON.stringify(exported))).toEqual(plan);
    const storage = new MemoryStorage();
    saveProject(storage, plan, null, "r1", now);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
    expect(listProjects(storage).projects[0].plan.wallRoomLabels).toEqual(plan.wallRoomLabels);
  });
  it.each([
    undefined, null, {},
    [{ id: "broken" }],
    [{ ...labelledWallPlan().wallRoomLabels[0], anchor: { x: 2, y: "2" } }],
    [{ ...labelledWallPlan().wallRoomLabels[0], boundaryWallIds: ["wall-0", "wall-0"] }],
    [{ ...labelledWallPlan().wallRoomLabels[0], color: "red" }],
    [{ ...labelledWallPlan().wallRoomLabels[0], outer: [] }],
  ])("rejects malformed current metadata without repairing or replacing it %#", (wallRoomLabels) => {
    const plan = { ...labelledWallPlan(), wallRoomLabels };
    expect(() => parsePlanFile(JSON.stringify(plan))).toThrow();
    const storage = new MemoryStorage();
    const raw = JSON.stringify({ storageVersion: 1, revision: "bad", updatedAt: now, plan });
    storage.setItem(PROJECT_PREFIX + plan.id, raw);
    expect(() => readProject(storage, plan.id)).toThrow();
    expect(listProjects(storage).unreadableCount).toBe(1);
    expect(storage.getItem(PROJECT_PREFIX + plan.id)).toBe(raw);
  });
  it("keeps large accepted plans importable after export formatting", () => {
    const wallId = (index: number) => `w${index}${"界".repeat(80)}`;
    const plan = {
      ...createEmptyPlan("large"),
      walls: Array.from({ length: 1000 }, (_, index) => ({
        id: wallId(index),
        start: { x: 0, y: 0 },
        end: { x: 4, y: 0 },
        thickness: 0.2,
        height: 3,
      })),
      openings: Array.from({ length: 1000 }, (_, index) => ({
        id: `o${index}${"界".repeat(80)}`,
        wallId: wallId(index),
        kind: "door" as const,
        offset: 0,
        width: 1,
        height: 2,
        sillHeight: 0,
      })),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(plan, null, 2)).byteLength,
    ).toBeLessThanOrEqual(MAX_PLAN_FILE_BYTES);
    const accepted = parsePlanFile(JSON.stringify(plan));
    expect(parsePlanFile(serializePlan(accepted))).toEqual(accepted);
  });
  it("roundtrips all geometry including future wall/opening fields", () => {
    const plan = {
      ...createExamplePlan(),
      walls: [
        {
          id: "w",
          start: { x: 0, y: 0 },
          end: { x: 4, y: 0 },
          thickness: 0.2,
          height: 3,
        },
      ],
      openings: [
        {
          id: "o",
          wallId: "w",
          kind: "door" as const,
          offset: 0.5,
          width: 1,
          height: 2,
          sillHeight: 0,
        },
      ],
    };
    expect(parsePlanFile(serializePlan(plan))).toEqual(plan);
    expect(parsePlanFile("\uFEFF" + serializePlan(plan))).toEqual(plan);
  });
  it.each([
    "{",
    "null",
    "[]",
    '{"schemaVersion":3}',
    JSON.stringify({ ...createExamplePlan(), unit: "mm" }),
  ])("rejects malformed or unsupported import %#", (text) => {
    expect(() => parsePlanFile(text)).toThrow();
  });
  it("rejects overlaps, duplicate objects, infinite values and files over 4 MB", () => {
    const plan = createExamplePlan();
    expect(() =>
      parsePlanFile(
        JSON.stringify({
          ...plan,
          rooms: [...plan.rooms, { ...plan.rooms[0], id: "overlap" }],
        }),
      ),
    ).toThrow(/пересек/);
    expect(() =>
      parsePlanFile(
        JSON.stringify({ ...plan, rooms: [...plan.rooms, plan.rooms[0]] }),
      ),
    ).toThrow();
    expect(() =>
      parsePlanFile(
        JSON.stringify({ ...plan, rooms: [{ ...plan.rooms[0], x: Infinity }] }),
      ),
    ).toThrow();
    expect(() => parsePlanFile(" ".repeat(MAX_PLAN_FILE_BYTES + 1))).toThrow(
      /4 МБ/,
    );
  });
  it("creates portable filenames", () => {
    expect(makeExportFilename("Квартира / Москва")).toBe(
      "Квартира - Москва.spaceplan.json",
    );
    expect(makeExportFilename("CON")).toBe("Проект-CON.spaceplan.json");
    expect(makeExportFilename(" ")).toBe("SpacePlan.spaceplan.json");
  });
});
