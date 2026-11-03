import { cp, mkdir, readFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Serve the exact installed worker and fonts locally, including after npm ci.
const require = createRequire(import.meta.url);
const source = dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(project, "public", "pdfjs", version);
await mkdir(destination, { recursive: true });
await copyFile(
  join(source, "build", "pdf.worker.min.mjs"),
  join(destination, "pdf.worker.min.mjs"),
);
await copyFile(join(source, "LICENSE"), join(destination, "LICENSE"));
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(join(source, directory), join(destination, directory), {
    recursive: true,
  });
}
console.log(`Local PDF.js assets ready (${version}).`);
