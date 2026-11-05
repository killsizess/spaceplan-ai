import { describe, expect, it } from "vitest";
import {
  createDefaultRoom,
  createEmptyPlan,
  getTotalArea,
} from "@/domain/floor-plan/operations";
import {
  ACTIVE_PROJECT_KEY,
  listProjects,
  PROJECT_PREFIX,
  readProject,
  readTrashedProject,
  renameProject,
  restoreProject,
  saveProject,
  serializePlan,
  trashProject,
} from "./project-repository";
import { ProjectWorkspace } from "./project-workspace";
import { createTestServices, MemoryStorage } from "./project-test-helpers";
import { addRectangularWallRoom } from "@/domain/floor-plan/rectangular-wall-room";

async function setup() {
  const services = createTestServices();
  const workspace = new ProjectWorkspace();
  workspace.initialize(services);
  await workspace.flush();
  return { workspace, services, storage: services.storage };
}

describe("project workspace lifecycle", () => {
  it("opens a version 3 plan without writing it until a successful model edit", async () => {
    const storage = new MemoryStorage();
    const oldPlan = {
      schemaVersion: 3, unit: "m", id: "legacy-walls", name: "Стены v3",
      roomMode: "walls", rooms: [], walls: [], openings: [],
    };
    const raw = JSON.stringify({
      storageVersion: 1, revision: "legacy", updatedAt: "2026-10-19T00:00:00.000Z",
      plan: oldPlan,
    });
    storage.setItem(PROJECT_PREFIX + oldPlan.id, raw);
    storage.setItem(ACTIVE_PROJECT_KEY, oldPlan.id);
    const workspace = new ProjectWorkspace();
    workspace.initialize(createTestServices(storage));
    await workspace.flush();
    expect(workspace.getSnapshot().editor.plan).toEqual({
      ...oldPlan, schemaVersion: 9, wallRoomLabels: [], requirements: [],
    });
    expect(workspace.hasUnsavedChanges()).toBe(false);
    expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
    const invalidWall = {
      id: "wall", start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
      thickness: 0.2, height: 2.7,
    };
    workspace.dispatch({ type: "wall:add", wall: invalidWall });
    await workspace.flush();
    expect(workspace.getSnapshot().editor.error).toBeTruthy();
    expect(storage.getItem(PROJECT_PREFIX + oldPlan.id)).toBe(raw);
    workspace.dispatch({ type: "wall:add", wall: { ...invalidWall, end: { x: 5, y: 0 } } });
    await workspace.flush();
    const saved = JSON.parse(storage.getItem(PROJECT_PREFIX + oldPlan.id)!);
    expect(saved.plan.schemaVersion).toBe(9);
    expect(saved.plan.wallRoomLabels).toEqual([]);
    expect(saved.plan.walls).toHaveLength(1);
  });
  it("restores the last project and keeps initialization idempotent", async () => {
    const { workspace, services, storage } = await setup();
    await workspace.createProject("Мой план");
    const plan = workspace.getSnapshot().editor.plan;
    workspace.dispatch({ type: "add", room: createDefaultRoom(plan, "room") });
    await workspace.flush();
    const restored = new ProjectWorkspace();
    restored.initialize(services);
    restored.initialize(services);
    expect(restored.getSnapshot().editor.plan.name).toBe("Мой план");
    expect(getTotalArea(restored.getSnapshot().editor.plan)).toBe(12);
    expect(listProjects(storage).projects).toHaveLength(2);
    expect(restored.hasUnsavedChanges()).toBe(false);
  });
  it("switches projects without leaking their undo history", async () => {
    const { workspace } = await setup();
    const firstId = workspace.getSnapshot().editor.plan.id;
    await workspace.createProject("Second");
    expect(workspace.getSnapshot().editor.past).toHaveLength(0);
    await workspace.openProject(firstId);
    expect(getTotalArea(workspace.getSnapshot().editor.plan)).toBe(80);
    workspace.dispatch({ type: "undo" });
    expect(workspace.getSnapshot().editor.plan.id).toBe(firstId);
  });
  it("serializes rapid edits and saves undo without regressing geometry", async () => {
    const { workspace, storage } = await setup();
    await workspace.createProject("New");
    const plan = workspace.getSnapshot().editor.plan;
    const room = createDefaultRoom(plan, "room");
    workspace.dispatch({ type: "add", room });
    workspace.dispatch({ type: "update", room: { ...room, width: 5 } });
    await workspace.flush();
    expect(getTotalArea(readProject(storage, plan.id)!.plan)).toBe(15);
    workspace.dispatch({ type: "undo" });
    await workspace.flush();
    expect(getTotalArea(readProject(storage, plan.id)!.plan)).toBe(12);
  });
  it("preserves working and saved plans on quota failure, then retries", async () => {
    const { workspace, storage } = await setup();
    await workspace.createProject("New");
    const plan = workspace.getSnapshot().editor.plan;
    storage.failWrites = true;
    workspace.dispatch({ type: "add", room: createDefaultRoom(plan, "room") });
    await workspace.flush();
    expect(workspace.getSnapshot().status).toBe("error");
    expect(getTotalArea(workspace.getSnapshot().editor.plan)).toBe(12);
    expect(getTotalArea(readProject(storage, plan.id)!.plan)).toBe(0);
    expect(await workspace.createProject("Unsafe switch")).toBe(false);
    expect(workspace.getSnapshot().editor.plan.id).toBe(plan.id);
    storage.failWrites = false;
    workspace.retrySave();
    await workspace.flush();
    expect(workspace.getSnapshot().status).toBe("saved");
    expect(getTotalArea(readProject(storage, plan.id)!.plan)).toBe(12);
  });
  it("keeps other tabs' changes and permits a separate local copy", async () => {
    const { workspace, services, storage } = await setup();
    const plan = workspace.getSnapshot().editor.plan;
    const other = new ProjectWorkspace();
    other.initialize(services);
    const room = plan.rooms[0];
    workspace.dispatch({
      type: "update",
      room: { ...room, name: "Other version" },
    });
    await workspace.flush();
    other.syncFromOtherTab();
    expect(other.getSnapshot().status).toBe("conflict");
    other.dispatch({ type: "update", room: { ...room, name: "My version" } });
    await other.flush();
    expect(readProject(storage, plan.id)!.plan.rooms[0].name).toBe(
      "Other version",
    );
    expect(await other.saveCopy()).toBe(true);
    expect(other.getSnapshot().editor.plan.id).not.toBe(plan.id);
    expect(other.getSnapshot().editor.plan.rooms[0].name).toBe("My version");
    expect(listProjects(storage).projects).toHaveLength(2);
  });
  it("validates imports first, always creates a new identity and preserves originals", async () => {
    const { workspace, storage } = await setup();
    const plan = workspace.getSnapshot().editor.plan;
    expect(await workspace.importProject("{")).toBe(false);
    expect(workspace.getSnapshot().editor.plan).toBe(plan);
    expect(await workspace.importProject(serializePlan(plan))).toBe(true);
    expect(workspace.getSnapshot().editor.plan.id).not.toBe(plan.id);
    expect(readProject(storage, plan.id)!.plan).toEqual(plan);
    expect(listProjects(storage).projects).toHaveLength(2);
  });
  it("keeps room labels when importing or saving a copy and preserves the current project on invalid import", async () => {
    const { workspace, storage } = await setup();
    const original = workspace.getSnapshot().editor.plan;
    const originalRaw = storage.getItem(PROJECT_PREFIX + original.id);
    const rectangle = addRectangularWallRoom(
      createEmptyPlan("portable"),
      { x: 0, y: 0, width: 5, depth: 4, thickness: 0.2, wallHeight: 2.7 },
      ["top", "right", "bottom", "left"],
    );
    const labelled = {
      ...rectangle,
      wallRoomLabels: [{
        id: "label", name: "Спальня", kind: "bedroom" as const, color: "#aabbcc",
        anchor: { x: 2.5, y: 2 }, boundaryWallIds: rectangle.walls.map((wall) => wall.id),
      }],
    };
    expect(await workspace.importProject(JSON.stringify({ ...labelled, wallRoomLabels: null }))).toBe(false);
    expect(workspace.getSnapshot().editor.plan).toBe(original);
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(originalRaw);
    expect(await workspace.importProject(serializePlan(labelled))).toBe(true);
    const imported = workspace.getSnapshot().editor.plan;
    expect(imported.id).not.toBe(labelled.id);
    expect(imported.wallRoomLabels).toEqual(labelled.wallRoomLabels);
    expect(await workspace.saveCopy()).toBe(true);
    const copied = workspace.getSnapshot().editor.plan;
    expect(copied.id).not.toBe(imported.id);
    expect(copied.wallRoomLabels).toEqual(labelled.wallRoomLabels);
    expect(readProject(storage, imported.id)!.plan.wallRoomLabels).toEqual(labelled.wallRoomLabels);
    expect(readProject(storage, copied.id)!.plan.wallRoomLabels).toEqual(labelled.wallRoomLabels);
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(originalRaw);
  });
  it("creates a variant as a saved, separate copy and leaves the original in the library", async () => {
    const { workspace, storage } = await setup();
    const original = workspace.getSnapshot().editor.plan;
    workspace.dispatch({ type: "update", room: { ...original.rooms[0], name: "Перед вариантом" } });
    expect(await workspace.createVariant()).toBe(true);
    const variant = workspace.getSnapshot().editor.plan;
    expect(variant.id).not.toBe(original.id);
    expect(variant.name).toBe(`${original.name} · вариант`);
    expect(variant.rooms).toEqual(readProject(storage, original.id)!.plan.rooms);
    // The edit before branching was saved to the original first.
    expect(readProject(storage, original.id)!.plan.rooms[0].name).toBe("Перед вариантом");
    expect(readProject(storage, variant.id)!.plan.rooms[0].name).toBe("Перед вариантом");
    expect(workspace.getSnapshot().editor.past).toEqual([]);
    expect(listProjects(storage).projects.map((project) => project.plan.id).sort()).toEqual([original.id, variant.id].sort());
  });
  it("retains corrupted records while opening valid saved projects", async () => {
    const storage = new MemoryStorage(),
      services = createTestServices(storage);
    storage.setItem(PROJECT_PREFIX + "corrupt", "not json");
    storage.setItem(ACTIVE_PROJECT_KEY, "corrupt");
    saveProject(
      storage,
      createEmptyPlan("valid"),
      null,
      "r",
      "2026-10-19T00:00:00.000Z",
    );
    const workspace = new ProjectWorkspace();
    workspace.initialize(services);
    expect(workspace.getSnapshot().editor.plan.id).toBe("valid");
    expect(workspace.getSnapshot().unreadableCount).toBe(1);
    expect(storage.getItem(PROJECT_PREFIX + "corrupt")).toBe("not json");
  });
});

describe("project library changes", () => {
  const now = "2026-10-24T12:00:00.000Z";
  const revision = (workspace: ProjectWorkspace, id = workspace.getSnapshot().editor.plan.id) =>
    workspace.getSnapshot().projects.find((project) => project.plan.id === id)!.revision;

  it("renames the current plan outside geometry history and keeps selection and geometry references", async () => {
    const { workspace, storage } = await setup();
    await workspace.createProject("Before");
    const room = createDefaultRoom(workspace.getSnapshot().editor.plan, "room");
    workspace.dispatch({ type: "add", room });
    workspace.dispatch({ type: "update", room: { ...room, width: 5 } });
    workspace.dispatch({ type: "undo" });
    workspace.dispatch({ type: "select", id: room.id });
    await workspace.flush();
    const before = workspace.getSnapshot().editor;
    expect(await workspace.renameProject(before.plan.id, "  После  ", revision(workspace))).toBe(true);
    const after = workspace.getSnapshot().editor;
    expect(after.selectedId).toBe(before.selectedId);
    expect(after.error).toBe(before.error);
    expect(after.plan.rooms).toBe(before.plan.rooms);
    expect(after.plan.walls).toBe(before.plan.walls);
    expect(after.plan.openings).toBe(before.plan.openings);
    expect(after.past).toHaveLength(before.past.length);
    expect(after.future).toHaveLength(before.future.length);
    expect(after.past[0].rooms).toBe(before.past[0].rooms);
    expect(after.future[0].rooms).toBe(before.future[0].rooms);
    expect([after.plan, ...after.past, ...after.future].every((plan) => plan.name === "После")).toBe(true);
    expect(workspace.hasUnsavedChanges()).toBe(false);
    workspace.dispatch({ type: "undo" });
    await workspace.flush();
    expect(readProject(storage, before.plan.id)!.plan.name).toBe("После");
    expect(getTotalArea(workspace.getSnapshot().editor.plan)).toBe(0);
    workspace.dispatch({ type: "redo" });
    await workspace.flush();
    expect(workspace.getSnapshot().editor.plan.name).toBe("После");
    expect(getTotalArea(workspace.getSnapshot().editor.plan)).toBe(12);
  });
  it("flushes autosave before checking a dialog revision without falsely conflicting with its own save", async () => {
    const { workspace, storage } = await setup();
    const before = workspace.getSnapshot().editor.plan;
    const oldRevision = revision(workspace);
    workspace.dispatch({ type: "update", room: { ...before.rooms[0], name: "Новая комната" } });
    expect(await workspace.renameProject(before.id, "Новое название", oldRevision)).toBe(false);
    expect(workspace.getSnapshot().status).toBe("saved");
    expect(readProject(storage, before.id)!.plan.rooms[0].name).toBe("Новая комната");
    expect(workspace.getSnapshot().editor.plan.name).toBe(before.name);
    expect(await workspace.renameProject(before.id, "Новое название", revision(workspace))).toBe(true);
  });
  it("rejects invalid and failed renames without altering the model, history or record", async () => {
    const { workspace, storage } = await setup();
    const before = workspace.getSnapshot().editor;
    const raw = storage.getItem(PROJECT_PREFIX + before.plan.id);
    expect(await workspace.renameProject(before.plan.id, " ", revision(workspace))).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(before);
    expect(storage.getItem(PROJECT_PREFIX + before.plan.id)).toBe(raw);
    storage.failWrites = true;
    expect(await workspace.renameProject(before.plan.id, "Новый", revision(workspace))).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(before);
    expect(storage.getItem(PROJECT_PREFIX + before.plan.id)).toBe(raw);
    expect(workspace.hasUnsavedChanges()).toBe(false);
  });
  it("allows changes to inactive projects while retaining the current conflicted working copy", async () => {
    const { workspace, storage } = await setup();
    const first = workspace.getSnapshot().editor.plan;
    await workspace.createProject("Неактивный");
    const inactive = workspace.getSnapshot().editor.plan;
    await workspace.openProject(first.id);
    renameProject(storage, first.id, "Во второй вкладке", revision(workspace), "external", now);
    workspace.syncFromOtherTab();
    workspace.dispatch({ type: "update", room: { ...first.rooms[0], name: "Рабочая версия" } });
    const before = workspace.getSnapshot();
    expect(await workspace.renameProject(inactive.id, "Переименован", revision(workspace, inactive.id))).toBe(true);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().storageError).toBe(before.storageError);
    expect(await workspace.trashProject(inactive.id, revision(workspace, inactive.id))).toBe(true);
    const trash = workspace.getSnapshot().trash[0];
    expect(await workspace.restoreProject(inactive.id, trash.revision)).toBe(true);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().storageError).toBe(before.storageError);
  });
  it("rejects renaming or trashing the current conflicted plan even with the newest library revision", async () => {
    const { workspace, storage } = await setup();
    const before = workspace.getSnapshot().editor;
    renameProject(storage, before.plan.id, "Внешнее название", revision(workspace), "external", now);
    workspace.syncFromOtherTab();
    expect(await workspace.renameProject(before.plan.id, "Старое", revision(workspace))).toBe(false);
    expect(await workspace.trashProject(before.plan.id, revision(workspace))).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(before);
    expect(readProject(storage, before.plan.id)!.plan.name).toBe("Внешнее название");
    expect(workspace.getSnapshot().trash).toHaveLength(0);
  });
  it("moves an inactive project to the trash without changing the current editor or active pointer", async () => {
    const { workspace, storage } = await setup();
    const inactive = workspace.getSnapshot().editor.plan;
    await workspace.createProject("Текущий");
    workspace.dispatch({ type: "add", room: createDefaultRoom(workspace.getSnapshot().editor.plan, "new-room") });
    await workspace.flush();
    const before = workspace.getSnapshot();
    expect(await workspace.trashProject(inactive.id, revision(workspace, inactive.id))).toBe(true);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().status).toBe(before.status);
    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe(before.editor.plan.id);
    expect(readProject(storage, inactive.id)).toBeNull();
    expect(readTrashedProject(storage, inactive.id)!.plan).toEqual(inactive);
    expect(storage.getItem(PROJECT_PREFIX + inactive.id)).not.toBeNull();
  });
  it("switches to another valid project only after the current tombstone commits", async () => {
    const { workspace, storage } = await setup();
    const fallback = workspace.getSnapshot().editor.plan;
    await workspace.createProject("Убираемый");
    const current = workspace.getSnapshot().editor.plan;
    workspace.dispatch({ type: "add", room: createDefaultRoom(current, "room") });
    await workspace.flush();
    const savedPlan = workspace.getSnapshot().editor.plan;
    expect(await workspace.trashProject(current.id, revision(workspace))).toBe(true);
    expect(workspace.getSnapshot().editor.plan).toEqual(fallback);
    expect(workspace.getSnapshot().editor.past).toHaveLength(0);
    expect(workspace.getSnapshot().editor.future).toHaveLength(0);
    expect(workspace.hasUnsavedChanges()).toBe(false);
    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe(fallback.id);
    expect(readTrashedProject(storage, current.id)!.plan).toEqual(savedPlan);
  });
  it("creates an empty project when the last active project is trashed and restores without opening it", async () => {
    const { workspace, storage } = await setup();
    const original = workspace.getSnapshot().editor.plan;
    expect(await workspace.trashProject(original.id, revision(workspace))).toBe(true);
    await workspace.flush();
    const empty = workspace.getSnapshot().editor.plan;
    expect(empty.id).not.toBe(original.id);
    expect(empty.rooms).toHaveLength(0);
    expect(empty.walls).toHaveLength(0);
    expect(workspace.getSnapshot().projects).toHaveLength(1);
    workspace.dispatch({ type: "add", room: createDefaultRoom(empty, "room") });
    await workspace.flush();
    const before = workspace.getSnapshot();
    expect(await workspace.restoreProject(original.id, before.trash[0].revision)).toBe(true);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().status).toBe(before.status);
    expect(workspace.getSnapshot().projects).toHaveLength(2);
    expect(workspace.getSnapshot().trash).toHaveLength(0);
    expect(readProject(storage, original.id)!.plan).toEqual(original);
    expect(storage.getItem(ACTIVE_PROJECT_KEY)).toBe(empty.id);
  });
  it("preserves the current plan and saved record when the trash write exceeds quota", async () => {
    const { workspace, storage } = await setup();
    const before = workspace.getSnapshot();
    const raw = storage.getItem(PROJECT_PREFIX + before.editor.plan.id);
    storage.failWrites = true;
    expect(await workspace.trashProject(before.editor.plan.id, revision(workspace))).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().busy).toBe(false);
    expect(storage.getItem(PROJECT_PREFIX + before.editor.plan.id)).toBe(raw);
    expect(workspace.getSnapshot().trash).toHaveLength(0);
  });
  it("keeps a committed current trash operation successful when active-pointer writes fail", async () => {
    class PointerFailureStorage extends MemoryStorage {
      failPointer = false;
      override setItem(key: string, value: string) {
        if (this.failPointer && key === ACTIVE_PROJECT_KEY)
          throw new DOMException("Unavailable", "SecurityError");
        super.setItem(key, value);
      }
    }
    const storage = new PointerFailureStorage();
    const workspace = new ProjectWorkspace();
    workspace.initialize(createTestServices(storage));
    await workspace.flush();
    const fallback = workspace.getSnapshot().editor.plan;
    await workspace.createProject("Удаляемый");
    const currentId = workspace.getSnapshot().editor.plan.id;
    storage.failPointer = true;
    expect(await workspace.trashProject(currentId, revision(workspace))).toBe(true);
    expect(workspace.getSnapshot().editor.plan).toEqual(fallback);
    expect(workspace.getSnapshot().status).toBe("saved");
    expect(workspace.getSnapshot().notice).toContain("Проект перемещён в корзину");
    expect(readTrashedProject(storage, currentId)).not.toBeNull();
    expect(workspace.getSnapshot().busy).toBe(false);
  });
  it("keeps the last original recoverable if saving the replacement empty project fails", async () => {
    class ReplacementFailureStorage extends MemoryStorage {
      originalId: string | null = null;
      override setItem(key: string, value: string) {
        if (this.originalId && key.startsWith(PROJECT_PREFIX) && key !== PROJECT_PREFIX + this.originalId)
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        super.setItem(key, value);
      }
    }
    const storage = new ReplacementFailureStorage();
    const workspace = new ProjectWorkspace();
    workspace.initialize(createTestServices(storage));
    await workspace.flush();
    const original = workspace.getSnapshot().editor.plan;
    storage.originalId = original.id;
    expect(await workspace.trashProject(original.id, revision(workspace))).toBe(true);
    await workspace.flush();
    expect(workspace.getSnapshot().editor.plan.id).not.toBe(original.id);
    expect(workspace.getSnapshot().editor.plan.rooms).toHaveLength(0);
    expect(workspace.getSnapshot().status).toBe("error");
    expect(workspace.hasUnsavedChanges()).toBe(true);
    expect(readTrashedProject(storage, original.id)!.plan).toEqual(original);
    storage.originalId = null;
    workspace.retrySave();
    await workspace.flush();
    expect(workspace.getSnapshot().status).toBe("saved");
    expect(await workspace.restoreProject(original.id, workspace.getSnapshot().trash[0].revision)).toBe(true);
  });
  it("checks the expected revision inside the same project lock and blocks competing local actions", async () => {
    const { workspace, services, storage } = await setup();
    const original = workspace.getSnapshot().editor;
    let release: () => void = () => {};
    let entered = false;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const lockKeys: string[] = [];
    services.withLock = async (key, work) => {
      lockKeys.push(key);
      entered = true;
      await barrier;
      work();
    };
    const pending = workspace.renameProject(original.plan.id, "Моё название", revision(workspace));
    while (!entered) await Promise.resolve();
    expect(workspace.getSnapshot().busy).toBe(true);
    expect(await workspace.trashProject(original.plan.id, revision(workspace))).toBe(false);
    expect(await workspace.reloadSaved()).toBe(false);
    workspace.retrySave();
    workspace.dispatch({ type: "delete", id: original.plan.rooms[0].id });
    expect(workspace.getSnapshot().editor).toBe(original);
    renameProject(storage, original.plan.id, "Название другой вкладки", revision(workspace), "external", now);
    release();
    expect(await pending).toBe(false);
    expect(lockKeys).toEqual([`spaceplan-ai:save:${original.plan.id}`]);
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().editor).toBe(original);
    expect(readProject(storage, original.plan.id)!.plan.name).toBe("Название другой вкладки");
    expect(workspace.getSnapshot().busy).toBe(false);
  });
  it("treats external trash as a conflict, keeps edits and saves a copy without resurrecting the record", async () => {
    const { workspace, storage } = await setup();
    const original = workspace.getSnapshot().editor.plan;
    trashProject(storage, original.id, revision(workspace), "trash-external", now);
    const tombstone = storage.getItem(PROJECT_PREFIX + original.id);
    workspace.syncFromOtherTab();
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().storageError).toContain("в корзине");
    workspace.dispatch({ type: "update", room: { ...original.rooms[0], name: "Моя комната" } });
    workspace.retrySave();
    await workspace.flush();
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
    expect(await workspace.reloadSaved()).toBe(false);
    expect(workspace.getSnapshot().editor.plan.rooms[0].name).toBe("Моя комната");
    expect(await workspace.saveCopy()).toBe(true);
    expect(workspace.getSnapshot().editor.plan.id).not.toBe(original.id);
    expect(workspace.getSnapshot().editor.plan.rooms[0].name).toBe("Моя комната");
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
  });
  it("detects external trash during autosave even before the storage event arrives", async () => {
    const { workspace, storage } = await setup();
    const original = workspace.getSnapshot().editor.plan;
    trashProject(storage, original.id, revision(workspace), "trash-external", now);
    const tombstone = storage.getItem(PROJECT_PREFIX + original.id);
    workspace.dispatch({ type: "update", room: { ...original.rooms[0], name: "Моя комната" } });
    await workspace.flush();
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().editor.plan.rooms[0].name).toBe("Моя комната");
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
  });
  it("opens and lists a committed recovery copy even when writing its active pointer fails", async () => {
    class PointerFailureStorage extends MemoryStorage {
      failPointer = false;
      override setItem(key: string, value: string) {
        if (this.failPointer && key === ACTIVE_PROJECT_KEY)
          throw new DOMException("Unavailable", "SecurityError");
        super.setItem(key, value);
      }
    }
    const storage = new PointerFailureStorage();
    const workspace = new ProjectWorkspace();
    const services = createTestServices(storage);
    workspace.initialize(services);
    await workspace.flush();
    const original = workspace.getSnapshot().editor.plan;
    trashProject(storage, original.id, revision(workspace), "external-trash", now);
    const tombstone = storage.getItem(PROJECT_PREFIX + original.id);
    workspace.syncFromOtherTab();
    workspace.dispatch({ type: "update", room: { ...original.rooms[0], name: "Моя несохранённая комната" } });
    const workingCopy = workspace.getSnapshot().editor;
    storage.failWrites = true;
    expect(await workspace.saveCopy()).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(workingCopy);
    expect(workspace.getSnapshot().status).toBe("conflict");
    expect(workspace.getSnapshot().projects).toHaveLength(0);
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
    storage.failWrites = false;
    storage.failPointer = true;
    expect(await workspace.saveCopy()).toBe(true);
    const recovered = workspace.getSnapshot();
    expect(recovered.editor.plan.id).not.toBe(original.id);
    expect(recovered.editor.plan.rooms[0].name).toBe("Моя несохранённая комната");
    expect(recovered.projects.map((project) => project.plan.id)).toContain(recovered.editor.plan.id);
    expect(readProject(storage, recovered.editor.plan.id)!.plan).toEqual(recovered.editor.plan);
    expect(recovered.status).toBe("saved");
    expect(workspace.hasUnsavedChanges()).toBe(false);
    expect(recovered.notice).toContain("Проект сохранён и открыт");
    expect(recovered.busy).toBe(false);
    expect(recovered.trash).toHaveLength(1);
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
    // Reload ignores the stale pointer to the trash and finds the real copy.
    const reloaded = new ProjectWorkspace();
    reloaded.initialize(services);
    expect(reloaded.getSnapshot().editor.plan).toEqual(recovered.editor.plan);
  });
  it("ignores a stale active pointer to the trash at initialization and retains corrupt records", async () => {
    const storage = new MemoryStorage();
    const original = createEmptyPlan("trashed-original");
    saveProject(storage, original, null, "active", now);
    trashProject(storage, original.id, "active", "trashed", now);
    const tombstone = storage.getItem(PROJECT_PREFIX + original.id);
    storage.setItem(ACTIVE_PROJECT_KEY, original.id);
    storage.setItem(PROJECT_PREFIX + "corrupt", "broken");
    const workspace = new ProjectWorkspace();
    workspace.initialize(createTestServices(storage));
    await workspace.flush();
    expect(workspace.getSnapshot().editor.plan.id).not.toBe(original.id);
    expect(workspace.getSnapshot().trash).toHaveLength(1);
    expect(workspace.getSnapshot().projects).toHaveLength(1);
    expect(workspace.getSnapshot().unreadableCount).toBe(1);
    expect(storage.getItem(PROJECT_PREFIX + original.id)).toBe(tombstone);
    expect(storage.getItem(PROJECT_PREFIX + "corrupt")).toBe("broken");
  });
  it("preserves the trash record and working state on restore quota failure or stale revision", async () => {
    const { workspace, storage } = await setup();
    const inactive = workspace.getSnapshot().editor.plan;
    await workspace.createProject("Открытый");
    expect(await workspace.trashProject(inactive.id, revision(workspace, inactive.id))).toBe(true);
    const before = workspace.getSnapshot();
    const trashed = before.trash[0];
    const raw = storage.getItem(PROJECT_PREFIX + inactive.id);
    storage.failWrites = true;
    expect(await workspace.restoreProject(inactive.id, trashed.revision)).toBe(false);
    expect(storage.getItem(PROJECT_PREFIX + inactive.id)).toBe(raw);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    storage.failWrites = false;
    restoreProject(storage, inactive.id, trashed.revision, "external-restore", now);
    expect(await workspace.restoreProject(inactive.id, trashed.revision)).toBe(false);
    expect(workspace.getSnapshot().editor).toBe(before.editor);
    expect(workspace.getSnapshot().status).toBe(before.status);
    expect(readProject(storage, inactive.id)!.revision).toBe("external-restore");
  });
});
