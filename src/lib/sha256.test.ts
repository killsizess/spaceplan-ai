import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "./sha256";

describe("sha256", () => {
  it("matches the published test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with Node's own on Russian text and at block boundaries", () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const text = "стена".repeat(length).slice(0, length);
      expect(sha256(text), String(length)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});
