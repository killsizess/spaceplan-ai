import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createSpatialExamplePlan } from "../src/domain/floor-plan/examples";
import { createEmptyPlan, createExamplePlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { setWallRoomLabel } from "../src/domain/floor-plan/wall-room-labels";
import { detectWallRooms } from "../src/domain/floor-plan/wall-rooms";

const ACTIVE_KEY = "spaceplan-ai:active-project:v1";
const PREFIX = "spaceplan-ai:project:";
const A = "management-active";
const B = "management-other";
const A_NAME = "Квартира на Садовой";
const B_NAME = "Дом с подписанными помещениями";

interface StoredRecord {
  storageVersion: 1 | 2;
  revision: string;
  updatedAt: string;
  trashedAt?: string;
  plan: FloorPlan;
}

const library = (page: Page) => page.getByRole("dialog", { name: /Мои проекты/ });
const card = (page: Page, id: string, trashed = false) => library(page).locator(
  `[data-testid="${trashed ? "trashed-project" : "saved-project"}"][data-project-id="${id}"]`,
);

function decoratedPlan(): FloorPlan {
  let plan: FloorPlan = {
    ...createSpatialExamplePlan(), id: B, name: B_NAME, roomMode: "walls",
    underlay: {
      name: "Скан плана.png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHfoAAAAASUVORK5CYII=",
      pixelWidth: 1, pixelHeight: 1, x: -0.5, y: -0.25,
      metersPerPixel: 10, opacity: 0.35, visible: true, calibrated: true,
    },
  };
  for (const [index, room] of detectWallRooms(plan.walls).rooms.entries()) {
    plan = setWallRoomLabel(plan, room, {
      name: index === 0 ? "Гостиная у окна" : `Помещение ${index + 1}`,
      kind: index === 0 ? "living" : "other",
      color: index === 0 ? "#d84646" : "#dfe8df",
    }, `management-label-${index}`);
  }
  return plan;
}

async function seed(page: Page, plans: FloorPlan[], activeId = plans[0].id) {
  await page.addInitScript(({ plans, activeId }) => {
    // A reload must exercise the persisted changes, not reinstall the fixture.
    if (localStorage.getItem("management-fixture-installed")) return;
    localStorage.setItem("management-fixture-installed", "yes");
    for (const [index, plan] of plans.entries()) {
      localStorage.setItem("spaceplan-ai:project:" + plan.id, JSON.stringify({
        storageVersion: 1, revision: `management-revision-${index}`,
        updatedAt: `2026-10-24T10:0${index}:00.000Z`, plan,
      }));
    }
    localStorage.setItem("spaceplan-ai:active-project:v1", activeId);
  }, { plans, activeId });
}

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  const record = await activeRecord(page);
  if (!record) throw new Error("Missing active saved project");
  return record.plan;
}

async function activeId(page: Page): Promise<string> {
  const id = await page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY);
  if (!id) throw new Error("Missing active project id");
  return id;
}

async function rawRecord(page: Page, id: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), PREFIX + id);
}

async function record(page: Page, id: string): Promise<StoredRecord> {
  const raw = await rawRecord(page, id);
  if (!raw) throw new Error(`Missing project record ${id}`);
  return JSON.parse(raw) as StoredRecord;
}

async function activeRecord(page: Page): Promise<StoredRecord | null> {
  const raw = await rawRecord(page, await activeId(page));
  return raw ? JSON.parse(raw) as StoredRecord : null;
}

async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "Мои проекты", exact: true }).click();
  await expect(library(page)).toBeVisible();
}

async function closeLibrary(page: Page) {
  await library(page).getByRole("button", { name: "Закрыть мои проекты", exact: true }).click();
  await expect(library(page)).toHaveCount(0);
}

async function rename(page: Page, id: string, previousName: string, nextName: string) {
  const target = card(page, id);
  await target.getByRole("button", { name: `Переименовать ${previousName}`, exact: true }).click();
  await target.getByLabel("Новое название проекта", { exact: true }).fill(nextName);
  await target.getByRole("button", { name: "Сохранить название", exact: true }).click();
  await expect(target.getByRole("heading", { name: nextName.trim(), exact: true })).toBeVisible();
}

async function confirmTrash(page: Page, id: string, name: string) {
  const target = card(page, id);
  await target.getByRole("button", { name: `В корзину ${name}`, exact: true }).click();
  await expect(target).toContainText(name);
  await target.getByRole("button", { name: "Переместить в корзину", exact: true }).click();
  await expect(target).toHaveCount(0);
}

async function camera(page: Page): Promise<string[]> {
  return page.getByTestId("plan-canvas").evaluate((node) =>
    ["data-camera-x", "data-camera-y", "data-scale"].map((key) => node.getAttribute(key) ?? ""),
  );
}

async function quota(page: Page, enabled: boolean) {
  await page.evaluate((enabled) => {
    const target = window as Window & { managementQuota?: boolean; managementQuotaInstalled?: boolean };
    target.managementQuota = enabled;
    if (target.managementQuotaInstalled) return;
    target.managementQuotaInstalled = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (target.managementQuota && key.startsWith("spaceplan-ai:project:")) {
        throw new DOMException("Full", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, enabled);
}

test("renaming the active project preserves geometry, camera, selection and geometry history and updates JSON", async ({ page }) => {
  await page.goto("/");
  const original = await saved(page);
  const id = original.id;
  await page.getByLabel("Ширина", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Применить изменения", exact: true }).click();
  const changed = await saved(page);
  await expect(page.getByTestId("total-area")).toHaveText("72 м²");
  const canvas = page.getByTestId("plan-canvas");
  await canvas.hover();
  const initialCamera = await camera(page);
  await page.mouse.wheel(0, -150);
  await expect.poll(() => camera(page)).not.toEqual(initialCamera);
  const beforeCamera = await camera(page);

  await openLibrary(page);
  await rename(page, id, original.name, "  План квартиры после ремонта  ");
  const renamed = await record(page, id);
  expect(renamed.storageVersion).toBe(1);
  expect(renamed.plan).toEqual({ ...changed, name: "План квартиры после ремонта" });
  await expect(card(page, id)).toContainText("Открыт сейчас");
  await page.screenshot({ path: "../SpacePlan-AI-projects.png", fullPage: true, animations: "disabled" });
  await closeLibrary(page);
  await expect(page.getByRole("heading", { name: renamed.plan.name, exact: true })).toBeVisible();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Гостиная");
  expect(await camera(page)).toEqual(beforeCamera);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeEnabled();

  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe("План квартиры после ремонта.spaceplan.json");
  const path = await download.path();
  if (!path) throw new Error("Missing renamed project download");
  expect(JSON.parse((await readFile(path)).toString("utf8"))).toEqual(renamed.plan);

  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await saved(page)).toEqual({ ...original, name: renamed.plan.name });
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  expect(await camera(page)).toEqual(beforeCamera);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect(await saved(page)).toEqual(renamed.plan);
  expect(await camera(page)).toEqual(beforeCamera);
});

test("invalid, unchanged and cancelled inactive renames preserve the stored record and active plan", async ({ page }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }, decoratedPlan()]);
  await page.goto("/");
  const current = await saved(page);
  const previous = await rawRecord(page, B);
  await openLibrary(page);
  const target = card(page, B);
  await target.getByRole("button", { name: `Переименовать ${B_NAME}`, exact: true }).click();
  const input = target.getByLabel("Новое название проекта", { exact: true });
  for (const invalid of ["   ", "Я".repeat(101)]) {
    await input.fill(invalid);
    await target.getByRole("button", { name: "Сохранить название", exact: true }).click();
    await expect(library(page).getByRole("alert").first()).toBeVisible();
    expect(await rawRecord(page, B)).toBe(previous);
  }
  await input.fill("Не сохранённое название");
  await target.getByRole("button", { name: "Отменить переименование", exact: true }).click();
  await expect(target.getByRole("heading", { name: B_NAME, exact: true })).toBeVisible();
  expect(await rawRecord(page, B)).toBe(previous);

  await target.getByRole("button", { name: `Переименовать ${B_NAME}`, exact: true }).click();
  await target.getByLabel("Новое название проекта", { exact: true }).fill(`  ${B_NAME}  `);
  const save = target.getByRole("button", { name: "Сохранить название", exact: true });
  if (await save.isEnabled()) await save.click();
  expect(await rawRecord(page, B)).toBe(previous);
  await closeLibrary(page);
  expect(await saved(page)).toEqual(current);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
});

test("inactive trash requires confirmation and survives reload; restore retains the exact labelled plan and underlay without opening it", async ({ page }) => {
  const original = decoratedPlan();
  await seed(page, [{ ...createEmptyPlan(A), name: "Рабочий проект" }, original]);
  await page.goto("/");
  const current = await saved(page);
  const previous = await rawRecord(page, B);
  await openLibrary(page);
  const target = card(page, B);
  await target.getByRole("button", { name: `В корзину ${B_NAME}`, exact: true }).click();
  expect(await rawRecord(page, B)).toBe(previous);
  await target.getByRole("button", { name: "Отмена удаления", exact: true }).click();
  expect(await rawRecord(page, B)).toBe(previous);
  await confirmTrash(page, B, B_NAME);
  const trashed = await record(page, B);
  expect(trashed.storageVersion).toBe(2);
  expect(trashed.trashedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(trashed.plan).toEqual(original);
  expect(await activeId(page)).toBe(A);
  await library(page).getByRole("button", { name: "Корзина", exact: true }).click();
  await expect(card(page, B, true)).toBeVisible();
  await page.screenshot({ path: "../SpacePlan-AI-trash.png", fullPage: true, animations: "disabled" });
  await page.reload();
  expect(await saved(page)).toEqual(current);
  expect(await record(page, B)).toEqual(trashed);
  await openLibrary(page);
  await library(page).getByRole("button", { name: "Корзина", exact: true }).click();
  await card(page, B, true).getByRole("button", { name: `Восстановить ${B_NAME}`, exact: true }).click();
  await expect(card(page, B, true)).toHaveCount(0);
  const restored = await record(page, B);
  expect(restored.storageVersion).toBe(1);
  expect(restored).not.toHaveProperty("trashedAt");
  expect(restored.plan).toEqual(original);
  expect(await activeId(page)).toBe(A);
  await library(page).getByRole("button", { name: "Проекты", exact: true }).click();
  await card(page, B).getByRole("button", { name: `Открыть ${B_NAME}`, exact: true }).click();
  expect(await saved(page)).toEqual(original);
  await expect(page.getByTestId("total-area")).toHaveText("73,42 м²");
});

test("trashing the active project chooses a saved fallback and trashing the last active project creates a saved blank plan", async ({ page }) => {
  const other = { ...createEmptyPlan(B), name: "Запасной проект" };
  await seed(page, [{ ...createExamplePlan(), id: A }, other]);
  await page.goto("/");
  const original = await saved(page);
  await openLibrary(page);
  await confirmTrash(page, A, A_NAME);
  await expect.poll(() => activeId(page)).toBe(B);
  await expect(card(page, B)).toContainText("Открыт сейчас");
  expect((await record(page, A)).plan).toEqual(original);
  await confirmTrash(page, B, other.name);
  await saved(page);
  const blankId = await activeId(page);
  expect([A, B]).not.toContain(blankId);
  const blank = await record(page, blankId);
  expect(blank.storageVersion).toBe(1);
  expect(blank.plan).toMatchObject({ roomMode: "manual", rooms: [], walls: [], openings: [], wallRoomLabels: [] });
  expect((await record(page, A)).storageVersion).toBe(2);
  expect((await record(page, B)).storageVersion).toBe(2);
  await expect(library(page).getByTestId("saved-project")).toHaveCount(1);
  await library(page).getByRole("button", { name: "Корзина", exact: true }).click();
  await expect(library(page).getByTestId("trashed-project")).toHaveCount(2);
  await closeLibrary(page);
  expect(await saved(page)).toEqual(blank.plan);
  await expect(page.getByRole("button", { name: "Добавить первую комнату", exact: true })).toBeVisible();
  await page.reload();
  expect(await saved(page)).toEqual(blank.plan);
});

test("quota errors in rename and trash preserve the original saved record and current model until retry", async ({ page }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }, decoratedPlan()]);
  await page.goto("/");
  const original = await saved(page);
  const previous = await rawRecord(page, A);
  await quota(page, true);
  await openLibrary(page);
  const target = card(page, A);
  await target.getByRole("button", { name: `Переименовать ${A_NAME}`, exact: true }).click();
  await target.getByLabel("Новое название проекта", { exact: true }).fill("Не удалось сохранить");
  await target.getByRole("button", { name: "Сохранить название", exact: true }).click();
  await expect(library(page).getByTestId("library-notice")).toContainText(/заполнено|сохранить/);
  expect(await rawRecord(page, A)).toBe(previous);
  expect(await activeId(page)).toBe(A);
  await target.getByRole("button", { name: "Отменить переименование", exact: true }).click();
  await target.getByRole("button", { name: `В корзину ${A_NAME}`, exact: true }).click();
  await target.getByRole("button", { name: "Переместить в корзину", exact: true }).click();
  await expect(library(page).getByTestId("library-notice")).toContainText(/заполнено|сохранить/);
  expect(await rawRecord(page, A)).toBe(previous);
  expect(await activeId(page)).toBe(A);
  await closeLibrary(page);
  expect(await saved(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeDisabled();
  await quota(page, false);
  await openLibrary(page);
  await rename(page, A, A_NAME, "Сохранённое новое название");
  expect((await record(page, A)).plan).toEqual({ ...original, name: "Сохранённое новое название" });
});

test("stale library cards in another tab cannot overwrite a later rename or trash a later revision", async ({ page, context }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }, decoratedPlan()]);
  await page.addInitScript(() => {
    const target = window as Window & { freezeManagementEvents?: boolean };
    window.addEventListener("storage", (event) => {
      if (target.freezeManagementEvents) event.stopImmediatePropagation();
    }, true);
  });
  await page.goto("/");
  await saved(page);
  const other = await context.newPage();
  await other.goto("/");
  await saved(other);
  await openLibrary(page);
  await openLibrary(other);
  await page.evaluate(() => { (window as Window & { freezeManagementEvents?: boolean }).freezeManagementEvents = true; });
  await rename(other, B, B_NAME, "Название из другой вкладки");
  const latest = await rawRecord(page, B);
  const stale = card(page, B);
  await stale.getByRole("button", { name: `Переименовать ${B_NAME}`, exact: true }).click();
  await stale.getByLabel("Новое название проекта", { exact: true }).fill("Устаревшая запись");
  await stale.getByRole("button", { name: "Сохранить название", exact: true }).click();
  await expect(library(page).getByTestId("library-notice")).toContainText(/другой вкладке|изменён/);
  expect(await rawRecord(page, B)).toBe(latest);
  await expect(stale.getByLabel("Новое название проекта", { exact: true })).toHaveCount(0);
  await expect(card(page, B).getByRole("heading", { name: "Название из другой вкладки", exact: true })).toBeVisible();
  // A rejected stale action must be recoverable in the same open dialog.
  await rename(page, B, "Название из другой вкладки", "Согласованное название");
  await expect(card(other, B).getByRole("heading", { name: "Согласованное название", exact: true })).toBeVisible();
  await rename(other, B, "Согласованное название", "Ещё одна сохранённая версия");
  const newest = await rawRecord(page, B);
  await card(page, B).getByRole("button", { name: "В корзину Согласованное название", exact: true }).click();
  await card(page, B).getByRole("button", { name: "Переместить в корзину", exact: true }).click();
  await expect(library(page).getByTestId("library-notice")).toContainText(/другой вкладке|изменён/);
  expect(await rawRecord(page, B)).toBe(newest);
  expect((await record(page, B)).storageVersion).toBe(1);
  await expect(card(page, B).getByRole("button", { name: "Переместить в корзину", exact: true })).toHaveCount(0);
  await expect(card(page, B).getByRole("heading", { name: "Ещё одна сохранённая версия", exact: true })).toBeVisible();
  const newestPlan = (await record(page, B)).plan;
  await confirmTrash(page, B, "Ещё одна сохранённая версия");
  const finallyTrashed = await record(page, B);
  expect(finallyTrashed.storageVersion).toBe(2);
  expect(finallyTrashed.plan).toEqual(newestPlan);
  expect(await activeId(page)).toBe(A);
  await other.close();
});

test("external trash of the current project creates a conflict; later edits recover as a separate copy without resurrection", async ({ page, context }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }, { ...createEmptyPlan(B), name: "Запасной проект" }]);
  await page.goto("/");
  const original = await saved(page);
  const other = await context.newPage();
  await other.goto("/");
  await saved(other);
  await openLibrary(other);
  await confirmTrash(other, A, A_NAME);
  await expect(page.getByTestId("save-status")).toHaveText("Конфликт версий");
  const trashed = await rawRecord(page, A);
  await page.getByLabel("Ширина", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Применить изменения", exact: true }).click();
  await expect(page.getByTestId("total-area")).toHaveText("72 м²");
  expect(await rawRecord(page, A)).toBe(trashed);
  await page.getByRole("button", { name: "Сохранить копию", exact: true }).click();
  const copy = await saved(page);
  expect([A, B]).not.toContain(copy.id);
  expect(copy.name).toBe(`${A_NAME} — копия`);
  expect(copy.rooms[0].width).toBe(3);
  expect(copy.rooms.slice(1)).toEqual(original.rooms.slice(1));
  expect(await rawRecord(page, A)).toBe(trashed);
  await openLibrary(page);
  await library(page).getByRole("button", { name: "Корзина", exact: true }).click();
  await card(page, A, true).getByRole("button", { name: `Восстановить ${A_NAME}`, exact: true }).click();
  expect((await record(page, A)).plan).toEqual(original);
  expect(await activeId(page)).toBe(copy.id);
  await other.close();
});

test("a committed recovery copy remains open and exportable when only the active-project pointer write fails", async ({ page, context }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }]);
  await page.goto("/");
  const original = await saved(page);
  const other = await context.newPage();
  await other.goto("/");
  await saved(other);
  await openLibrary(other);
  await confirmTrash(other, A, A_NAME);
  await saved(other);
  await expect(page.getByTestId("save-status")).toHaveText("Конфликт версий");
  const trashed = await rawRecord(page, A);
  const stalePointer = await activeId(page);
  await page.getByLabel("Ширина", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Применить изменения", exact: true }).click();
  await page.evaluate(() => {
    const target = window as Window & { managementPointerFailure?: boolean };
    target.managementPointerFailure = true;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (target.managementPointerFailure && key === "spaceplan-ai:active-project:v1") {
        throw new DOMException("Pointer unavailable", "QuotaExceededError");
      }
      return originalSet.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Сохранить копию", exact: true }).click();
  const copyName = `${A_NAME} — копия`;
  await expect(page.getByRole("heading", { name: copyName, exact: true })).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  await expect(page.getByTestId("project-notice")).toContainText("Проект сохранён и открыт");
  await expect(page.getByTestId("project-notice")).toContainText("Не удалось запомнить");
  expect(await activeId(page)).toBe(stalePointer);
  const copies = await page.evaluate((name) => Object.keys(localStorage)
    .filter((key) => key.startsWith("spaceplan-ai:project:"))
    .map((key) => JSON.parse(localStorage.getItem(key)!) as StoredRecord)
    .filter((record) => record.storageVersion === 1 && record.plan.name === name), copyName);
  expect(copies).toHaveLength(1);
  const copy = copies[0].plan;
  expect(copy.id).not.toBe(A);
  expect(copy.rooms).toEqual(original.rooms.map((room, index) => index === 0 ? { ...room, width: 3 } : room));
  expect(await rawRecord(page, A)).toBe(trashed);
  const pendingDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await pendingDownload;
  const path = await download.path();
  if (!path) throw new Error("Missing recovery copy JSON download");
  expect(JSON.parse((await readFile(path)).toString("utf8"))).toEqual(copy);
  await openLibrary(page);
  await expect(card(page, copy.id)).toContainText("Открыт сейчас");
  // The stale pointer may select another valid project on reload; the copy is
  // still a real saved record and can be explicitly opened from the library.
  await page.reload();
  await saved(page);
  await openLibrary(page);
  await card(page, copy.id).getByRole("button", { name: `Открыть ${copyName}`, exact: true }).click();
  expect(await saved(page)).toEqual(copy);
  expect(await rawRecord(page, A)).toBe(trashed);
  await other.close();
});

test("project management fits a 390px viewport, traps focus and returns it to the library trigger", async ({ page }) => {
  await seed(page, [{ ...createExamplePlan(), id: A }, decoratedPlan()]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await saved(page);
  const trigger = page.getByRole("button", { name: "Мои проекты", exact: true });
  await openLibrary(page);
  const target = card(page, A);
  await target.getByRole("button", { name: `Переименовать ${A_NAME}`, exact: true }).click();
  const input = target.getByLabel("Новое название проекта", { exact: true });
  await input.fill("Моя квартира — планировка после ремонта");
  await input.scrollIntoViewIfNeeded();
  for (const control of [input, target.getByRole("button", { name: "Сохранить название", exact: true }), target.getByRole("button", { name: "Отменить переименование", exact: true })]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await target.getByRole("button", { name: "Сохранить название", exact: true }).click();
  await expect(target.getByRole("heading", { name: "Моя квартира — планировка после ремонта", exact: true })).toBeVisible();
  await confirmTrash(page, B, B_NAME);
  await library(page).getByRole("button", { name: "Корзина", exact: true }).click();
  await expect(card(page, B, true)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "../../work/spaceplan-projects-mobile.png", fullPage: true, animations: "disabled" });
  // The native modal makes the editor inert, even to programmatic focus.
  await trigger.focus();
  expect(await library(page).evaluate((node) => node.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    const focus = await library(page).evaluate((node) => ({
      within: node.contains(document.activeElement),
      body: document.activeElement === document.body,
      modal: node.matches(":modal"),
      documentFocused: document.hasFocus(),
    }));
    expect(focus.modal).toBe(true);
    // Edge may Tab to browser chrome; it must never focus the underlying app.
    expect(focus.within || (!focus.documentFocused && focus.body), JSON.stringify({ index, ...focus })).toBe(true);
  }
  await library(page).getByRole("button", { name: "Закрыть мои проекты", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(library(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("heading", { name: "Моя квартира — планировка после ремонта", exact: true })).toBeVisible();
});
