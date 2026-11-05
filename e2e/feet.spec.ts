import { expect, test, type Page } from "@playwright/test";
import type { FloorPlan } from "../src/domain/floor-plan/types";

const FOOT = 0.3048;

async function saved(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
  return page.evaluate(() => JSON.parse(localStorage.getItem(
    "spaceplan-ai:project:" + localStorage.getItem("spaceplan-ai:active-project:v1"),
  )!).plan as FloorPlan);
}

async function openInFeet(page: Page) {
  await page.goto("/?lang=en&units=ft");
  await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
}

test("the plan reads in feet and inches, and the file stays in metres", async ({ page }) => {
  await openInFeet(page);
  // The example's living room is 5 × 4 m: 196.85 in is shown to the nearest eighth.
  const properties = page.locator(".properties-panel");
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("16' 4 7/8\"");
  await expect(properties.getByText("ft, in").first()).toBeVisible();
  await expect(page.locator(".scale-indicator small")).toContainText("ft");
  await expect(page.getByTestId("units-switch")).toHaveText("Metres");
  await expect(page.locator("body")).toContainText("sq ft");
  await expect(page.locator("body")).not.toContainText("m²");

  // Opened and untouched, the form has nothing to apply: 16' 4 7/8" is not quite 5 m.
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  const before = await saved(page);

  await page.getByLabel("Width", { exact: true }).fill("16'");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("16'");
  const after = await saved(page);
  const room = after.rooms.find((item) => item.name === "Living room");
  expect(room?.width).toBeCloseTo(16 * FOOT, 9);
  expect(after.unit).toBe("m");
  // Everything else, including the depth shown as 13' 1 1/2", is exactly as it was.
  expect({ ...room, width: 0 }).toEqual({ ...before.rooms.find((item) => item.name === "Living room"), width: 0 });
});

test("feet and inches are read the ways people type them, and nonsense is refused", async ({ page }) => {
  await openInFeet(page);
  const width = page.getByLabel("Width", { exact: true });
  // Each differs from the one before: the same value again has nothing to apply.
  for (const [typed, feet, shown] of [["12 6", 12.5, "12' 6\""], ["13ft 6in", 13.5, "13' 6\""], ["150\"", 12.5, "12' 6\""], ["13.5", 13.5, "13' 6\""]] as const) {
    await width.fill(typed);
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(width).toHaveValue(shown);
    const room = (await saved(page)).rooms.find((item) => item.name === "Living room");
    expect(room?.width, typed).toBeCloseTo(feet * FOOT, 9);
  }
  await width.fill("twelve");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter the room's size as numbers." })).toBeVisible();
  const room = (await saved(page)).rooms.find((item) => item.name === "Living room");
  expect(room?.width).toBeCloseTo(13.5 * FOOT, 9);
});

test("requirements and a developer's rules take square feet", async ({ page }) => {
  await openInFeet(page);
  await page.getByRole("tab", { name: "Rooms", exact: true }).click();
  await page.getByLabel("Area at least, sq ft").fill("100");
  await page.getByRole("button", { name: "Add requirement" }).click();
  const requirement = (await saved(page)).requirements.at(-1);
  expect(requirement?.type === "room-min-area" ? requirement.minArea : NaN).toBeCloseTo(100 * FOOT * FOOT, 6);
  await expect(page.locator(".requirements-panel")).toContainText("100 sq ft");

  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await page.getByLabel("Where the apartment is").selectOption("other");
  await page.getByLabel("Rules in your own words").fill("Kitchen at least 150 sq ft. Ceilings at least 8 ft.");
  await page.getByRole("button", { name: "Apply rules" }).click();
  const profile = page.getByTestId("xray-profile-rules");
  await expect(profile).toContainText("Kitchen: area at least 150 sq ft");
  await expect(profile).toContainText("Room height at least 8'");
});

test("the switch goes back to metres and remembers it", async ({ page }) => {
  await openInFeet(page);
  await page.getByTestId("units-switch").click();
  await expect(page.getByTestId("units-switch")).toHaveText("Feet");
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("5");
  expect(page.url()).not.toContain("units=");
  await page.reload();
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("5");
});

test.describe("a browser in the United States", () => {
  test.use({ locale: "en-US" });
  test("starts in feet and inches", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("units-switch")).toHaveText("Metres");
  });
});

test.describe("a browser in Britain", () => {
  test.use({ locale: "en-GB" });
  test("starts in metres", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("units-switch")).toHaveText("Feet");
  });
});
