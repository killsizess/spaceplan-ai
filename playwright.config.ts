import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../work/playwright-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010",
    // The first-visit hint changes the canvas size when a project opens; only its own tests need it.
    storageState: {
      cookies: [],
      origins: [{
        origin: new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3010").origin,
        localStorage: [{ name: "spaceplan-ai:welcome-hidden:v1", value: "1" }],
      }],
    },
    viewport: { width: 1440, height: 1000 },
    // The interface follows the browser's language; these tests read the Russian one.
    locale: "ru-RU",
    channel:
      process.env.PLAYWRIGHT_CHANNEL ??
      (process.platform === "win32" ? "msedge" : undefined),
    trace: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "npm run dev -- --port 3010 --hostname 127.0.0.1",
    url: "http://localhost:3010",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
