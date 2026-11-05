import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `npm run accuracy`: measures recognition over the plans in bench/plans. Not part of `npm test`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["bench/run-accuracy.test.ts"], silent: false },
});
