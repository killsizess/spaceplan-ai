import { expect, test, type Locator, type Page } from "@playwright/test";
import { createVariantsExamplePlan } from "../src/domain/generation/example-flat";


/** Everything a person can read or a screen reader says, with the Russian found in it. */
async function russianIn(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const pattern = /[А-Яа-яЁё]/;
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // The switch names Russian in Russian, on purpose.
      if (node.parentElement?.closest('[data-testid="language-switch"]')) continue;
      if (pattern.test(node.textContent ?? "")) found.push(`text: ${node.textContent}`);
    }
    for (const element of root.querySelectorAll("*")) {
      for (const name of ["aria-label", "title", "placeholder", "alt"]) {
        const value = element.getAttribute(name);
        if (value && pattern.test(value)) found.push(`${name}: ${value}`);
      }
    }
    return found;
  });
}

async function expectEnglish(page: Page, where: string, scope: Locator = page.locator("body")) {
  expect(await russianIn(scope), where).toEqual([]);
}

async function openEnglish(page: Page) {
  await page.goto("/?lang=en");
  await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
}

/** Room names are the owner's data and are never translated, so this plan brings English ones. */
const ROOM_NAMES: Readonly<Record<string, string>> = {
  Гостиная: "Living room",
  Спальня: "Bedroom",
  Кухня: "Kitchen",
  Прихожая: "Hall",
  Санузел: "Bathroom",
};

async function importExample(page: Page) {
  const plan = createVariantsExamplePlan();
  await page.getByLabel("Project file, JSON").setInputFiles({
    name: "example.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      ...plan,
      name: "Example flat",
      wallRoomLabels: plan.wallRoomLabels.map((label) => ({ ...label, name: ROOM_NAMES[label.name] })),
    })),
  });
  await expect(page.getByRole("heading", { name: "Example flat", exact: true })).toBeVisible();
}

test("every screen reads in English", async ({ page }) => {
  const errors: string[] = [];
  const missing: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().startsWith("No translation:")) missing.push(message.text());
  });

  await openEnglish(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectEnglish(page, "the example plan");
  await expect(page.locator("body")).toContainText("m²");

  for (const tab of ["Walls", "Underlay", "Rooms"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expectEnglish(page, `the ${tab} tab`);
  }

  await page.getByRole("button", { name: "Editor help" }).click();
  await expectEnglish(page, "help");
  await page.getByRole("button", { name: "Close help" }).click();

  await page.getByRole("button", { name: "3D mode", exact: true }).click();
  await expect(page.getByTestId("plan-three")).toHaveAttribute("data-renderer-status", "ready");
  await expectEnglish(page, "the 3D view");
  await page.getByRole("button", { name: "2D mode", exact: true }).click();

  await importExample(page);
  await expectEnglish(page, "a plan with walls, except its own names", page.locator(".scenario-rail"));
  await page.getByRole("tab", { name: "Walls", exact: true }).click();
  await page.getByRole("button", { name: "Select wall 5", exact: true }).click();
  await expectEnglish(page, "wall properties", page.locator(".properties-panel"));

  // X-Ray, with the rule base and its documents.
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  const xray = page.getByTestId("xray-dialog");
  await expect(xray).toContainText("Draft rule base.");
  await expectEnglish(page, "X-Ray", xray);

  // Proof, from a wall.
  await page.locator('[data-testid="xray-wall"][data-wall="living-kitchen"]').getByRole("button", { name: "What if removed" }).click();
  const proof = page.getByTestId("proof-dialog");
  await expect(proof.getByRole("heading", { name: "What if wall 6 is removed" })).toBeVisible();
  await expect(page.getByTestId("proof-alternative").filter({ hasText: "The apartment has gas" })).toContainText("Not permitted");
  await expect(page.getByTestId("proof-limits")).toContainText("Russian originals");
  await expectEnglish(page, "Proof", proof);
  await page.getByRole("button", { name: "Close Proof" }).click();
  await page.getByRole("button", { name: "Close X-Ray" }).click();

  // The generator.
  await page.locator('.scenario-rail [data-step="variants"]').getByRole("button").click();
  const variants = page.getByTestId("variants-dialog");
  await variants.getByRole("button", { name: "Suggest variants" }).click();
  await expect(page.getByTestId("variant-card")).toHaveCount(6);
  await expectEnglish(page, "the generator", variants);
  await page.getByTestId("variant-card").first().getByRole("button", { name: "Save as a variant" }).click();
  await expect(page.getByRole("heading", { name: /suggestion 1/ })).toBeVisible();

  // The report and the comparison of a variant.
  await page.locator('.scenario-rail [data-step="report"]').getByRole("button").click();
  await expect(page.getByTestId("report-verdict")).toBeVisible();
  await expectEnglish(page, "the report", page.locator("dialog[open]"));
  await page.getByRole("button", { name: "Close report" }).click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expectEnglish(page, "the comparison", page.locator("dialog[open]"));
  await page.getByRole("button", { name: "Close comparison" }).click();

  await page.getByRole("button", { name: "Check the plan" }).click();
  await expectEnglish(page, "the plan check", page.locator("dialog[open]"));
  await page.getByRole("button", { name: "Close plan check" }).click();

  await page.getByRole("button", { name: "My projects", exact: true }).click();
  await expectEnglish(page, "the library", page.locator("dialog[open]"));
  await page.getByRole("button", { name: "Close my projects" }).click();

  expect(errors).toEqual([]);
  expect(missing).toEqual([]);
});

test("numbers read the English way", async ({ page }) => {
  await openEnglish(page);
  await importExample(page);
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await page.locator('[data-testid="xray-wall"][data-wall="living-bedroom"]').getByRole("button", { name: "What if removed" }).click();
  await expect(page.getByTestId("proof-area")).toHaveText("81.9 m² → 82.86 m²");
});

test("a developer's rules in English are understood and answered in English", async ({ page }) => {
  await openEnglish(page);
  await importExample(page);
  await page.getByRole("button", { name: "X-Ray", exact: true }).click();
  await page.getByLabel("Where the apartment is").selectOption("other");
  await page.getByLabel("Rules in your own words").fill("Kitchen at least 15 m2. Do not touch bearing walls.");
  await page.getByRole("button", { name: "Apply rules" }).click();
  const profile = page.getByTestId("xray-profile-rules");
  await expect(profile).toContainText("Kitchen: area at least");
  await expect(profile).toContainText("Bearing walls stay unchanged");
  await expectEnglish(page, "the developer's rules", page.getByTestId("xray-dialog"));
});

test("the language can be switched back and forth, and the work stays", async ({ page }) => {
  await openEnglish(page);
  await importExample(page);
  await page.getByTestId("language-switch").click();
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { name: "Example flat", exact: true })).toBeVisible();
  expect(page.url()).not.toContain("lang=");

  // Remembered after a reload, with no link parameter.
  await page.reload();
  await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");

  await page.getByTestId("language-switch").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
  await expect(page.getByRole("heading", { name: "Example flat", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
});

test.describe("a browser in another language", () => {
  test.use({ locale: "de-DE" });
  test("starts in English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("save-status")).toHaveText("Saved in the browser");
    await expect(page.getByTestId("language-switch")).toHaveText("Русский");
  });
});

test.describe("a browser in Belarusian", () => {
  test.use({ locale: "be-BY" });
  test("starts in Russian", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("save-status")).toHaveText("Сохранено в браузере");
    await expect(page.getByTestId("language-switch")).toHaveText("English");
  });
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width} wide`, () => {
    test.use({ viewport });

    test("English text fits the screen", async ({ page }) => {
      await openEnglish(page);
      await importExample(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "X-Ray", exact: true }).click();
      const dialog = page.getByTestId("xray-dialog");
      await expect(dialog).toBeVisible();
      const scroll = dialog.locator(".plan-report-scroll");
      expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
  });
}
