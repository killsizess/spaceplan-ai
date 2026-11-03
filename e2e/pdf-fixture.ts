import { createHash } from "node:crypto";

const PASSWORD_PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

function paddedPassword(password: string) {
  return Buffer.concat([Buffer.from(password, "ascii"), PASSWORD_PADDING]).subarray(
    0,
    32,
  );
}

function md5(bytes: Buffer) {
  return createHash("md5").update(bytes).digest();
}

/** RC4 is used only to build an old-format password-protected test document. */
function rc4(key: Buffer, bytes: Buffer) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const result = Buffer.alloc(bytes.length);
  let i = 0;
  j = 0;
  for (let position = 0; position < bytes.length; position++) {
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    result[position] =
      bytes[position] ^ state[(state[i] + state[j]) % 256];
  }
  return result;
}

/** One-page PDF with the given content stream; offsets are computed from the bytes. */
function singlePagePdf(content: string, width: number, height: number): Buffer {
  const body = Buffer.from(content, "ascii");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${body.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const chunks = [Buffer.from("%PDF-1.4\n%SpacePlanAI\n", "ascii")];
  const offsets: number[] = [];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii");
    chunks.push(bytes);
    position += bytes.length;
  });
  chunks.push(Buffer.from([
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`,
  ].join(""), "ascii"));
  return Buffer.concat(chunks);
}

/** PDF units per metre in `wallPlanPdfFixture` (1 unit = 2 cm). */
export const WALL_PLAN_UNITS_PER_METRE = 50;
/** PDF coordinate of plan metre 0 on both axes in `wallPlanPdfFixture`. */
export const WALL_PLAN_ORIGIN = 50;

/**
 * A 600 × 400 vector plan drawn as architects draw walls: two thin face lines per
 * wall. The apartment is 10 × 6 m with 0.2 m walls, a partition at x = 6 m and a
 * branch at y = 3 m; a label and a single furniture line must not become walls.
 */
export function wallPlanPdfFixture(): Buffer {
  const faces: [number, number, number, number][] = [
    [-0.1, -0.1, 10.1, -0.1], [10.1, -0.1, 10.1, 6.1], [10.1, 6.1, -0.1, 6.1], [-0.1, 6.1, -0.1, -0.1],
    [0.1, 0.1, 5.9, 0.1], [6.1, 0.1, 9.9, 0.1], [0.1, 5.9, 5.9, 5.9], [6.1, 5.9, 9.9, 5.9],
    [0.1, 0.1, 0.1, 5.9], [9.9, 0.1, 9.9, 2.9], [9.9, 3.1, 9.9, 5.9],
    [5.9, 0.1, 5.9, 5.9], [6.1, 0.1, 6.1, 2.9], [6.1, 3.1, 6.1, 5.9],
    [6.1, 2.9, 9.9, 2.9], [6.1, 3.1, 9.9, 3.1],
  ];
  const unit = (metres: number) => WALL_PLAN_ORIGIN + metres * WALL_PLAN_UNITS_PER_METRE;
  const content = [
    "0.2 0.25 0.22 RG 0.4 w",
    ...faces.map(([x1, y1, x2, y2]) => `${unit(x1)} ${unit(y1)} m ${unit(x2)} ${unit(y2)} l S`),
    `${unit(1)} ${unit(4)} m ${unit(3)} ${unit(4)} l S`,
    "0.2 0.25 0.22 rg BT /F1 12 Tf 100 150 Td (LIVING) Tj ET",
  ].join("\n");
  return singlePagePdf(content, 600, 400);
}

/**
 * A deterministic two-page vector plan. Page 1 is 600x400, page 2 is 360x600.
 * Object offsets and stream lengths are computed from the actual bytes.
 */
export function pdfFixture(encrypted = false): Buffer {
  const documentId = md5(Buffer.from("spaceplan-ai-pdf-fixture", "ascii"));
  const owner = rc4(
    md5(paddedPassword("fixture-owner")).subarray(0, 5),
    paddedPassword("fixture-password"),
  );
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const documentKey = md5(
    Buffer.concat([
      paddedPassword("fixture-password"),
      owner,
      permissions,
      documentId,
    ]),
  ).subarray(0, 5);
  const user = rc4(documentKey, PASSWORD_PADDING);
  const stream = (objectId: number, content: string) => {
    let bytes = Buffer.from(content, "ascii");
    if (encrypted) {
      const object = Buffer.from([objectId, 0, 0, 0, 0]);
      bytes = rc4(
        md5(Buffer.concat([documentKey, object])).subarray(0, 10),
        bytes,
      );
    }
    return Buffer.concat([
      Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`, "ascii"),
      bytes,
      Buffer.from("\nendstream", "ascii"),
    ]);
  };
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream(
      4,
      [
        "0.94 0.96 0.92 rg 40 40 520 320 re f",
        "0.15 0.25 0.20 RG 7 w 40 40 520 320 re S",
        "4 w 300 40 m 300 360 l S",
        "0.15 0.25 0.20 rg BT /F1 20 Tf 80 200 Td (LIVING ROOM) Tj ET",
        "BT /F1 16 Tf 340 200 Td (KITCHEN) Tj ET",
      ].join("\n"),
    ),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 600] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream(
      6,
      [
        "0.91 0.95 0.98 rg 30 40 300 520 re f",
        "0.18 0.29 0.39 RG 7 w 30 40 300 520 re S",
        "4 w 30 330 m 330 330 l S 180 40 m 180 330 l S",
        "0.18 0.29 0.39 rg BT /F1 18 Tf 110 430 Td (BEDROOM) Tj ET",
        "BT /F1 12 Tf 55 175 Td (BATHROOM) Tj ET",
        "BT /F1 12 Tf 225 175 Td (HALL) Tj ET",
        "BT /F1 12 Tf 145 575 Td (PAGE 2) Tj ET",
        "0.2 0.5 0.8 rg 285 500 25 25 re f",
      ].join("\n"),
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (encrypted) {
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
    );
  }
  const chunks = [Buffer.from("%PDF-1.4\n%SpacePlanAI\n", "ascii")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      typeof object === "string" ? Buffer.from(object, "ascii") : object,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(bytes);
    position += bytes.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R`,
    encrypted
      ? ` /Encrypt 8 0 R /ID [<${documentId.toString("hex")}> <${documentId.toString("hex")}>]`
      : "",
    ` >>\nstartxref\n${position}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}
