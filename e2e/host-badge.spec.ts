import { expect, test, type Page } from "@playwright/test";
import { createEmptyPlan } from "../src/domain/floor-plan/operations";
import type { FloorPlan, Wall } from "../src/domain/floor-plan/types";

/**
 * Netlify's free plan puts a badge above every page of the site, and on that plan it cannot
 * be hidden. It sits above everything except modal dialogs, so a control left under it can
 * not be clicked at all. These tests look for such controls.
 *
 * On the published site the real badge is used. Elsewhere a stand-in takes its place, with
 * the area measured on the real one at five screen sizes: 186 × 48, 13 px from the corner.
 */
const BADGE = "nl-badge-frame";

async function placeBadge(page: Page) {
  const real = page.locator(`iframe#${BADGE}`);
  if (new URL(page.url()).hostname.endsWith(".netlify.app")) {
    await expect(real).toHaveAttribute("data-nl-ready", "1");
    return;
  }
  await page.evaluate((id) => {
    const badge = document.createElement("div");
    badge.id = id;
    badge.style.cssText =
      "position:fixed;right:13px;bottom:13px;width:186px;height:48px;z-index:2147483645;";
    document.body.append(badge);
  }, BADGE);
}

/**
 * Each visible control is scrolled as close to the middle as the page allows, and then
 * asked for what is on top of it. What is left under the badge cannot be reached.
 */
async function controlsUnderBadge(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const badge = document.getElementById(id);
    if (!badge) throw new Error("The badge is not on the page");
    const controls = document.querySelectorAll<HTMLElement>(
      "button, a[href], input, select, textarea, summary, [role='tab']",
    );
    const buried: string[] = [];
    for (const control of controls) {
      if (!control.checkVisibility() || control.closest("dialog")) continue;
      if ((control as HTMLButtonElement).disabled) continue;
      if (control.getBoundingClientRect().width < 2) continue;
      control.scrollIntoView({ block: "center", inline: "nearest" });
      const box = control.getBoundingClientRect();
      const inset = Math.min(2, box.width / 4, box.height / 4);
      const points = [
        [box.left + box.width / 2, box.top + box.height / 2],
        [box.left + inset, box.top + inset],
        [box.right - inset, box.top + inset],
        [box.left + inset, box.bottom - inset],
        [box.right - inset, box.bottom - inset],
      ];
      if (points.some(([x, y]) => document.elementFromPoint(x, y) === badge)) {
        buried.push(
          control.getAttribute("aria-label") ||
            control.textContent?.trim() ||
            control.getAttribute("name") ||
            control.tagName,
        );
      }
    }
    return buried;
  }, BADGE);
}

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.2,
  height: 2.7,
});

function plan(): FloorPlan {
  return {
    ...createEmptyPlan("host-badge"),
    name: "Углы экрана",
    roomMode: "walls",
    walls: [
      wall("top", 0, 0, 10, 0),
      wall("right", 10, 0, 10, 6),
      wall("bottom", 10, 6, 0, 6),
      wall("left", 0, 6, 0, 0),
      wall("partition", 6, 0, 6, 6),
    ],
  };
}

const SCREENS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

for (const viewport of SCREENS) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("the hosting badge covers no control on the plan, room or wall screens", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
      await placeBadge(page);

      // The example plan opens with a room selected, and its form is the longest panel.
      await expect(page.getByRole("button", { name: /Применить изменени/ })).toBeVisible();
      expect(await controlsUnderBadge(page), "a selected room").toEqual([]);

      await page.getByRole("button", { name: "Режим 3D", exact: true }).click();
      await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
      expect(await controlsUnderBadge(page), "the 3D view").toEqual([]);
      await page.getByRole("button", { name: "Режим 2D", exact: true }).click();

      await page.getByLabel("Файл проекта JSON").setInputFiles({
        name: "host-badge.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(plan())),
      });
      await expect(page.getByRole("heading", { name: "Углы экрана", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Стены", exact: true }).click();
      expect(await controlsUnderBadge(page), "the wall list").toEqual([]);

      await page.getByRole("button", { name: "Выбрать стену 5", exact: true }).click();
      await expect(page.getByRole("button", { name: "Удалить стену", exact: true })).toBeVisible();
      expect(await controlsUnderBadge(page), "a selected wall").toEqual([]);

      // Not only reachable: the click really lands on the button.
      await page.getByRole("button", { name: "Удалить стену", exact: true }).click({ timeout: 5000 });
      await expect(page.getByRole("button", { name: "Удалить стену", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Выбрать стену 5", exact: true })).toHaveCount(0);
    });
  });
}
