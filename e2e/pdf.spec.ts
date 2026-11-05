import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { FloorPlan } from "../src/domain/floor-plan/types";
import { pdfFixture } from "./pdf-fixture";

const PDF_NAME = "Квартира.pdf";

async function savedPlan(page: Page): Promise<FloorPlan> {
  await expect(page.getByTestId("save-status")).toHaveText(
    "Сохранено в браузере",
  );
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem(
          "spaceplan-ai:project:" +
            localStorage.getItem("spaceplan-ai:active-project:v1"),
        )!,
      ).plan as FloorPlan,
  );
}

async function choosePdf(page: Page, name = PDF_NAME, buffer = pdfFixture()) {
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.getByLabel("Файл плана PDF", { exact: true }).setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer,
  });
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Выберите страницу PDF" });
}

async function readyPreview(page: Page, number = 1, rotation = 0) {
  const preview = page.getByTestId("pdf-preview");
  await expect(preview).toHaveAttribute("data-page", String(number));
  await expect(preview).toHaveAttribute("data-rotation", String(rotation));
  await expect(preview).toHaveAttribute("data-status", "ready");
  await expect(
    dialog(page).getByRole("button", { name: "Использовать страницу" }),
  ).toBeEnabled();
  return preview;
}

async function applyPdf(page: Page) {
  await dialog(page)
    .getByRole("button", { name: "Использовать страницу" })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-underlay-loaded",
    "true",
  );
  return savedPlan(page);
}

test("PDF page selection and rotation preserve geometry, history and portable saves", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  // The site's own address is whatever the run was given: a local server or the published site.
  const ownHost = new URL(baseURL!).hostname;
  const workers: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => workers.push(worker.url()));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== ownHost
    ) {
      externalRequests.push(request.url());
    }
  });
  await page.goto("/");
  const original = await savedPlan(page);
  await choosePdf(page);
  await readyPreview(page);
  await dialog(page).getByLabel("Страница PDF", { exact: true }).fill("2");
  await dialog(page).getByLabel("Страница PDF", { exact: true }).press("Enter");
  const preview = await readyPreview(page, 2);
  expect(
    await preview.locator("canvas").evaluate(
      (canvas) =>
        (canvas as HTMLCanvasElement).width /
        (canvas as HTMLCanvasElement).height,
    ),
  ).toBeCloseTo(360 / 600, 2);
  const blueMarker = await preview.locator("canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing PDF preview raster");
    return [...context.getImageData(
      Math.round((297.5 / 360) * canvas.width),
      Math.round(((600 - 512.5) / 600) * canvas.height),
      1,
      1,
    ).data];
  });
  expect(blueMarker[2]).toBeGreaterThan(blueMarker[0] + 80);
  expect(blueMarker[2]).toBeGreaterThan(blueMarker[1] + 40);
  await dialog(page).getByRole("button", { name: "Повернуть страницу" }).click();
  await readyPreview(page, 2, 90);
  expect(
    await preview.locator("canvas").evaluate(
      (canvas) =>
        (canvas as HTMLCanvasElement).width /
        (canvas as HTMLCanvasElement).height,
    ),
  ).toBeCloseTo(600 / 360, 2);
  expect(await savedPlan(page)).toEqual(original);
  await page.screenshot({ path: "../SpacePlan-AI-PDF.png", fullPage: true });
  const imported = await applyPdf(page);
  expect(imported.underlay?.name).toContain("· стр. 2");
  expect(imported.underlay?.calibrated).toBe(false);
  expect(imported.underlay?.pixelWidth).toBeGreaterThan(
    imported.underlay?.pixelHeight ?? 0,
  );
  expect({ ...imported, underlay: original.underlay }).toEqual({
    ...original,
    underlay: original.underlay,
  });
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-tool",
    "calibrate",
  );
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect(await savedPlan(page)).toEqual(imported);
  await page.reload();
  expect(await savedPlan(page)).toEqual(imported);
  await expect(page.getByTestId("plan-canvas")).toHaveAttribute(
    "data-underlay-loaded",
    "true",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("Missing PDF-derived project download");
  const bytes = await readFile(path);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(imported);
  await page.getByLabel("Файл проекта JSON").setInputFiles({
    name: "from-pdf.spaceplan.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect
    .poll(async () => (await savedPlan(page)).id)
    .not.toBe(imported.id);
  const restored = await savedPlan(page);
  expect({ ...restored, id: imported.id }).toEqual(imported);
  await page.getByRole("tab", { name: "Подложка", exact: true }).click();
  await page.screenshot({
    path: "../SpacePlan-AI-PDF-plan.png",
    fullPage: true,
  });
  expect(workers.some((url) => url.includes("pdf.worker"))).toBe(true);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("cancelled PDF preview and pending reads keep the existing underlay", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await savedPlan(page);
  await choosePdf(page);
  await readyPreview(page);
  const original = await applyPdf(page);
  await choosePdf(page);
  await readyPreview(page);
  await dialog(page).getByLabel("Страница PDF", { exact: true }).fill("2");
  await dialog(page).getByLabel("Страница PDF", { exact: true }).press("Enter");
  await readyPreview(page, 2);
  await dialog(page).getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);

  await page.evaluate(() => {
    const target = window as Window & {
      pdfReadStarted?: boolean;
      releasePdfRead?: () => Promise<void>;
    };
    const originalRead = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.name === "Отмена.pdf") {
        target.pdfReadStarted = true;
        return new Promise<ArrayBuffer>((resolve, reject) => {
          target.releasePdfRead = async () => {
            try {
              resolve(await originalRead.call(this));
            } catch (error) {
              reject(error);
            }
          };
        });
      }
      return originalRead.call(this);
    };
  });
  await choosePdf(page, "Отмена.pdf");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { pdfReadStarted?: boolean }).pdfReadStarted,
      ),
    )
    .toBe(true);
  await expect(
    dialog(page).getByRole("button", { name: "Использовать страницу" }),
  ).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Закрыть импорт PDF" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(async () => {
    await (
      window as Window & { releasePdfRead?: () => Promise<void> }
    ).releasePdfRead?.();
  });
  // A subsequent successful load also exercises cleanup of the cancelled one.
  await choosePdf(page);
  await readyPreview(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByTestId("project-notice")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("invalid and password-protected PDFs leave the saved plan intact", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  const files = [
    { name: "empty.pdf", bytes: Buffer.alloc(0), message: /пуст|непуст/i },
    {
      name: "not-pdf.pdf",
      bytes: Buffer.from("This is not a PDF"),
      message: /PDF|содержим|формат/i,
    },
    {
      name: "broken.pdf",
      bytes: Buffer.from("%PDF-1.7\nBroken cross-reference and catalog\n%%EOF"),
      message: /повреж|открыть|прочитать|PDF/i,
    },
    {
      name: "too-big.pdf",
      bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
      message: /25|больш|размер/i,
    },
    {
      name: "protected.pdf",
      bytes: pdfFixture(true),
      message: /парол|защищ/i,
    },
  ];
  for (const file of files) {
    await choosePdf(page, file.name, file.bytes);
    const error = page
      .locator('[role="alert"]:visible:not(#__next-route-announcer__)')
      .or(page.getByTestId("project-notice"));
    await expect(error.first()).toContainText(file.message);
    expect(await savedPlan(page)).toEqual(original);
    if (await dialog(page).count()) {
      await dialog(page)
        .getByRole("button", { name: "Закрыть импорт PDF" })
        .click();
    }
    if (await page.getByTestId("project-notice").count()) {
      await page.getByRole("button", { name: "Закрыть сообщение" }).click();
    }
  }
  await choosePdf(page);
  await readyPreview(page);
  await dialog(page).getByRole("button", { name: "Отмена", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  expect(errors).toEqual([]);
});

test("PDF page picker fits a phone and validates the page range", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const original = await savedPlan(page);
  await choosePdf(page);
  await readyPreview(page);
  const modal = dialog(page);
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(845);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await modal.getByLabel("Страница PDF", { exact: true }).fill("99");
  await modal.getByLabel("Страница PDF", { exact: true }).press("Enter");
  await expect(modal.getByRole("alert")).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await modal.getByLabel("Страница PDF", { exact: true }).fill("2");
  await modal.getByLabel("Страница PDF", { exact: true }).press("Enter");
  await readyPreview(page, 2);
  await expect(modal.getByRole("alert")).toHaveCount(0);
  await modal
    .getByRole("button", { name: "Использовать страницу" })
    .scrollIntoViewIfNeeded();
  await expect(
    modal.getByRole("button", { name: "Использовать страницу" }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../work/spaceplan-pdf-mobile.png",
    fullPage: true,
  });
  await modal.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});
