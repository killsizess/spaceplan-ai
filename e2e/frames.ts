import type { Page } from "@playwright/test";

/**
 * The 3D view publishes `data-camera-position` from its next animation frame, not at the
 * moment a camera button is clicked. Reading the attribute right after the click returns
 * the previous camera on a fast machine. Two frames guarantee that the render has run.
 */
export async function settleFrames(page: Page, frames = 2) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(count);
      }),
    frames,
  );
}

/**
 * «Показать весь план» moves the 2D camera from an animation frame too. A scale or a screen
 * point read right after the click can still be the old one, and a press aimed with it
 * misses the wall. Nobody clicks that fast by hand; a test on a busy machine does.
 */
export async function fitPlan(page: Page) {
  await page.getByRole("button", { name: "Показать весь план", exact: true }).click();
  await settleCamera(page);
}

/**
 * Waits until the 2D camera has stood still for several frames. A fit can also come later
 * than the click: when the canvas changes size, the observer reports it a moment after.
 */
export async function settleCamera(page: Page) {
  await page.getByTestId("plan-canvas").evaluate((node) => new Promise<void>((resolve) => {
    const read = () => ["data-camera-x", "data-camera-y", "data-scale"].map((name) => node.getAttribute(name)).join();
    let last = read();
    let still = 0;
    let frames = 0;
    const step = () => {
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
      frames += 1;
      if (still >= 10 || frames >= 240) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
}
