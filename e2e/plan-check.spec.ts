import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

type CheckKind = "connections" | "intersections" | "overlaps" | "door-wall" | "door-pair";
const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.08): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, height: 2.7,
});

/** Four diagnostic sources; the two nearby endpoints describe one gap. */
function mixedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("plan-check-mixed"), name: "Проверка плана квартиры",
    walls: [
      wall("host-first", -1, 0, 2, 0, 0.12), wall("host-second", -0.9, -0.9, 2.1, -0.9, 0.12),
      wall("cross-a", 10, 0, 12, 0), wall("cross-b", 11, -1, 11, 1),
      wall("near-a", 20, 0, 21, 0), wall("near-b", 21.1, 0, 22, 0),
    ],
    openings: [
      { id: "window", wallId: "host-first", kind: "window", offset: 2.2, width: 0.4, height: 1.2, sillHeight: 0.8 },
      { id: "z-first", wallId: "host-first", kind: "door", offset: 1, width: 1, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
      { id: "a-second", wallId: "host-second", kind: "door", offset: 1, width: 0.4, height: 2.1, sillHeight: 0, door: { hinge: "start", side: "left" } },
    ],
  };
}

function closedPlan(): FloorPlan {
  return {
    ...createEmptyPlan("plan-check-closed"), name: "Замкнутые стены",
    walls: [wall("top", 0, 0, 5, 0), wall("right", 5, 0, 5, 4), wall("bottom", 5, 4, 0, 4), wall("left", 0, 4, 0, 0)],
  };
}

const trigger = (page: Page) => page.getByRole("button", { name: "Проверить план", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Проверка плана", exact: true });
const rows = (page: Page) => dialog(page).getByTestId("plan-check-item");
const filter = (page: Page, kind: CheckKind | "all") => dialog(page).getByTestId(`plan-check-filter-${kind}`);
const total = (page: Page) => page.getByTestId("plan-check-total");
const close = (page: Page) => dialog(page).getByRole("button", { name: "Закрыть проверку плана", exact: true });
const undo = (page: Page) => page.getByRole("button", { name: "Отменить", exact: true });
const redo = (page: Page) => page.getByRole("button", { name: "Повторить", exact: true });

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function rawRecord(page: Page): Promise<string> {
  await saved(page);
  return page.evaluate(() => localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!);
}

async function importPlan(page: Page, fixture = mixedPlan()): Promise<FloorPlan> {
  await page.goto("/");
  await saved(page);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "plan-check.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await expect(undo(page)).toBeDisabled();
  return saved(page);
}

async function openCheck(page: Page) {
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
}

async function camera(page: Page) {
  return page.getByTestId("plan-canvas").evaluate((node) => ({
    x: Number(node.getAttribute("data-camera-x")), y: Number(node.getAttribute("data-camera-y")),
    scale: Number(node.getAttribute("data-scale")), width: node.getBoundingClientRect().width,
    height: node.getBoundingClientRect().height,
  }));
}

async function settleFrames(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function markerPoint(page: Page, attribute: string): Promise<{ x: number; y: number }> {
  const markers = JSON.parse((await page.getByTestId("plan-canvas").getAttribute(attribute)) ?? "[]") as { point: { x: number; y: number } }[];
  expect(markers).toHaveLength(1);
  return markers[0].point;
}

test("one overview merges the four sources and counts a reciprocal endpoint gap once", async ({ page }) => {
  const original = await importPlan(page);
  const raw = await rawRecord(page);
  await expect(page.getByTestId("plan-check-count")).toHaveText("14");
  await openCheck(page);
  await expect(total(page)).toHaveText("14");
  await expect(filter(page, "all")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(6);
  await page.screenshot({ path: "../SpacePlan-AI-plan-check.png", fullPage: true });
  await filter(page, "connections").click();
  await expect(rows(page)).toHaveCount(6);
  await dialog(page).getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(rows(page)).toHaveCount(11);
  for (const kind of ["intersections", "door-wall", "door-pair"] as const) {
    await filter(page, kind).click();
    await expect(filter(page, kind)).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute("data-kind", kind);
  }
  await close(page).click();
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
});

test("every category locates its current geometry from 3D without changing the plan or manual zoom", async ({ page }) => {
  test.setTimeout(45000);
  const original = await importPlan(page);
  for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Увеличить масштаб", exact: true }).click();
  await settleFrames(page);
  const manualScale = (await camera(page)).scale;
  const wallPoint = await markerPoint(page, "data-door-collisions");
  const pairPoint = await markerPoint(page, "data-door-pair-collisions");
  const raw = await rawRecord(page);
  for (const kind of ["connections", "intersections", "door-wall", "door-pair"] as const) {
    if (kind === "connections") await page.getByRole("tab", { name: "Комнаты", exact: true }).click();
    if (kind === "intersections") await page.getByRole("tab", { name: "Подложка", exact: true }).click();
    await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
    await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
    await openCheck(page);
    await filter(page, kind).click();
    await rows(page).first().click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("plan-canvas")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Стены", exact: true })).toHaveAttribute("aria-selected", "true");
    await settleFrames(page);
    const focused = await camera(page);
    expect(focused.scale).toBeCloseTo(manualScale, 8);
    const centre = { x: (focused.width / 2 - focused.x) / focused.scale, y: (focused.height / 2 - focused.y) / focused.scale };
    if (kind === "connections") {
      const start = { x: Number(await page.getByLabel("Начало X", { exact: true }).inputValue()), y: Number(await page.getByLabel("Начало Y", { exact: true }).inputValue()) };
      const end = { x: Number(await page.getByLabel("Конец X", { exact: true }).inputValue()), y: Number(await page.getByLabel("Конец Y", { exact: true }).inputValue()) };
      expect(original.walls.some((item) => item.start.x === start.x && item.start.y === start.y && item.end.x === end.x && item.end.y === end.y)).toBe(true);
      expect(Math.min(Math.hypot(centre.x - start.x, centre.y - start.y), Math.hypot(centre.x - end.x, centre.y - end.y))).toBeLessThan(1e-6);
    } else if (kind === "intersections") {
      expect(centre.x).toBeCloseTo(11, 7); expect(centre.y).toBeCloseTo(0, 7);
      await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("10");
    } else {
      const point = kind === "door-wall" ? wallPoint : pairPoint;
      expect(centre.x).toBeCloseTo(point.x, 7); expect(centre.y).toBeCloseTo(point.y, 7);
      await expect(page.getByLabel("Стена проёма", { exact: true })).toHaveValue("host-first");
      await expect(page.getByLabel("Ширина проёма", { exact: true })).toHaveValue("1");
    }
    expect(await rawRecord(page)).toBe(raw);
    expect(await saved(page)).toEqual(original);
    await expect(undo(page)).toBeDisabled();
  }
});

test("a redrawn wall on top of another is listed as an overlap and located without changing the plan", async ({ page }) => {
  const fixture: FloorPlan = {
    ...createEmptyPlan("plan-check-overlap"), name: "Наложение стен",
    walls: [wall("base", 0, 0, 4, 0, 0.12), wall("copy", 3, 0, 1, 0, 0.12)],
    openings: [{
      id: "door", wallId: "base", kind: "door", offset: 1.6, width: 0.8, height: 2.1, sillHeight: 0,
      door: { hinge: "start", side: "left" },
    }],
  };
  const original = await importPlan(page, fixture);
  const raw = await rawRecord(page);
  await openCheck(page);
  await expect(filter(page, "overlaps")).toContainText("Наложения стен1");
  await filter(page, "overlaps").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute("data-kind", "overlaps");
  await expect(rows(page).first()).toContainText("Стены 1 и 2 лежат друг на друге");
  await expect(rows(page).first()).toContainText("на участке 2 м");
  await expect(rows(page).first()).toContainText("X: 2 м · Y: 0 м");
  await rows(page).first().click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Стены", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Начало X", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Конец X", { exact: true })).toHaveValue("4");
  await settleFrames(page);
  const focused = await camera(page);
  expect((focused.width / 2 - focused.x) / focused.scale).toBeCloseTo(2, 7);
  expect((focused.height / 2 - focused.y) / focused.scale).toBeCloseTo(0, 7);
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
});

test("fixing a door and undoing or redoing refreshes the overview without adding report history", async ({ page }) => {
  const original = await importPlan(page);
  await openCheck(page);
  await filter(page, "door-pair").click();
  await rows(page).first().click();
  await page.getByLabel("Петли двери", { exact: true }).selectOption("end");
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  const fixed = await saved(page);
  expect(fixed.openings[1].door).toEqual({ hinge: "end", side: "left" });
  await openCheck(page);
  await filter(page, "door-pair").click();
  await expect(rows(page)).toHaveCount(0);
  await close(page).click();
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(undo(page)).toBeDisabled();
  await openCheck(page);
  await filter(page, "door-pair").click();
  await expect(rows(page)).toHaveCount(1);
  await close(page).click();
  await redo(page).click();
  expect(await saved(page)).toEqual(fixed);
  await openCheck(page);
  await filter(page, "door-pair").click();
  await expect(rows(page)).toHaveCount(0);
});

test("native modal traps focus and closes with Escape or the backdrop, returning focus to its trigger", async ({ page }) => {
  await importPlan(page);
  const raw = await rawRecord(page);
  await openCheck(page);
  await expect(close(page)).toBeFocused();
  for (let step = 0; step < 18; step++) {
    await page.keyboard.press("Tab");
    const focus = await dialog(page).evaluate((node) => ({
      inside: node.contains(document.activeElement), activeTag: document.activeElement?.tagName,
      modal: node.matches(":modal"), documentFocused: document.hasFocus(),
    }));
    expect(focus.modal).toBe(true);
    // Native Chromium may send Tab to browser chrome. BODY is acceptable only
    // with an unfocused document; no editor control may receive modal focus.
    if (focus.documentFocused) expect(focus.inside, JSON.stringify(focus)).toBe(true);
    else expect(focus.activeTag).toBe("BODY");
  }
  await close(page).focus();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await openCheck(page);
  await page.mouse.click(2, 2);
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(await rawRecord(page)).toBe(raw);
});

test("a pending underlay read refreshes the live report and its locate action without reviving it after undo", async ({ page }) => {
  const original = await importPlan(page);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d")!; context.fillStyle = "#ece9e1"; context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.evaluate(() => {
    const arrayBuffer = File.prototype.arrayBuffer;
    let release: (() => void) | undefined;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "plan-check-delayed.png") return arrayBuffer.call(this);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        release = () => { void arrayBuffer.call(this).then(resolve, reject); };
      });
    };
    Object.defineProperty(window, "__planCheckReadPending", { configurable: true, get: () => Boolean(release) });
    Object.defineProperty(window, "__planCheckReleaseRead", { configurable: true, value: () => {
      File.prototype.arrayBuffer = arrayBuffer;
      if (!release) throw new Error("Missing pending underlay read");
      release();
    } });
  });
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Изображение плана JPG или PNG").setInputFiles({
    name: "plan-check-delayed.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__planCheckReadPending") as boolean)).toBe(true);
  await openCheck(page);
  await filter(page, "door-pair").click();
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "__planCheckReleaseRead");
    if (typeof release !== "function") throw new Error("Missing pending underlay release");
    release();
  });
  await expect.poll(async () => (await saved(page)).underlay?.name).toBe("plan-check-delayed.png");
  await expect(dialog(page)).toBeVisible();
  await expect(total(page)).toHaveText("14");
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByLabel("Стена проёма", { exact: true })).toHaveValue("host-first");
  expect((await saved(page)).underlay?.name).toBe("plan-check-delayed.png");
  await undo(page).click();
  expect(await saved(page)).toEqual(original);
  await expect(dialog(page)).toHaveCount(0);
});

test("the overview fits a 390px screen and locating still opens the actual door inspector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const original = await importPlan(page);
  await openCheck(page);
  await expect(total(page)).toHaveText("14");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = (await dialog(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await filter(page, "door-pair").click();
  await page.screenshot({ path: "../../work/SpacePlan-AI-plan-check-mobile.png", fullPage: false });
  await rows(page).first().click();
  await expect(page.getByLabel("Ширина проёма", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Стена проёма", { exact: true })).toHaveValue("host-first");
  expect(await saved(page)).toEqual(original);
});

test("capped categories remain explicit lower bounds and paginate without changing the model", async ({ page }) => {
  const fixture: FloorPlan = {
    ...createEmptyPlan("plan-check-capped"), name: "Ограниченный список проверок",
    walls: Array.from({ length: 16 }, (_, index) => wall(`wall-${index}`, -1 + index * 0.0001, 0, 2 + index * 0.0001, 0, 0.02)),
    openings: Array.from({ length: 16 }, (_, index) => ({
      id: `door-${index}`, wallId: `wall-${index}`, kind: "door" as const, offset: 1, width: 1, height: 2.1, sillHeight: 0,
      door: { hinge: "start" as const, side: "left" as const },
    })),
  };
  const original = await importPlan(page, fixture);
  const raw = await rawRecord(page);
  await expect(page.getByTestId("plan-check-count")).toHaveText(/^\d+\+$/);
  await openCheck(page);
  await expect(total(page)).toHaveText(/^\d+\+$/);
  await expect(filter(page, "door-pair")).toContainText("100+");
  await filter(page, "door-pair").click();
  await expect(rows(page)).toHaveCount(6);
  await expect(dialog(page)).toContainText(/огранич|непол|первые/i);
  await dialog(page).getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(rows(page)).toHaveCount(12);
  await filter(page, "connections").click();
  await filter(page, "door-pair").click();
  await expect(rows(page)).toHaveCount(6);
  await close(page).click();
  expect(await rawRecord(page)).toBe(raw);
  expect(await saved(page)).toEqual(original);
});

test("empty and closed plans are distinct and JSON or reload never stores the derived overview", async ({ page }) => {
  await importPlan(page, { ...createEmptyPlan("plan-check-empty"), name: "Пустой план" });
  await openCheck(page);
  await expect(total(page)).toHaveText("0");
  await expect(dialog(page)).toContainText(/Добавьте стены/);
  await close(page).click();
  const original = await importPlan(page, closedPlan());
  const raw = await rawRecord(page);
  await openCheck(page);
  await expect(total(page)).toHaveText("0");
  await expect(dialog(page)).toContainText("По этим проверкам замечаний нет");
  await expect(rows(page)).toHaveCount(0);
  await close(page).click();
  expect(await rawRecord(page)).toBe(raw);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloading;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as FloorPlan;
  expect(exported).toEqual(original);
  expect(exported.schemaVersion).toBe(10);
  for (const key of ["diagnostics", "planChecks", "report"]) expect(exported).not.toHaveProperty(key);
  await page.reload();
  await saved(page);
  await expect(dialog(page)).toHaveCount(0);
  await openCheck(page);
  await expect(total(page)).toHaveText("0");
  expect(await saved(page)).toEqual(original);
});
