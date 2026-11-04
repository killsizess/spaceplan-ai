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
