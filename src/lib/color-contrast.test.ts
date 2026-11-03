import { describe, expect, it } from "vitest";
import { readableRoomInk } from "./color-contrast";

describe("readable room ink", () => {
  it.each([
    ["#000000", "#ffffff"],
    ["#ffffff", "#41513e"],
    ["#d84646", "#000000"],
    ["#4477dd", "#000000"],
    ["#0000ff", "#ffffff"],
    ["#ffff00", "#41513e"],
    ["#808080", "#000000"],
    ["#dfe8df", "#41513e"],
  ])("keeps text visible on %s", (background, expected) => {
    expect(readableRoomInk(background, "#41513e")).toBe(expected);
  });
});
