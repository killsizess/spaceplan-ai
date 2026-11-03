import { expect, it } from "vitest";
import { BASE_SCALE, fitViewport } from "./viewport";

it("fits maximum-sized and distant rooms, including negative coordinates", () => {
  const rooms = [
    { x: -1000, y: -1000, width: 100, height: 100 },
    { x: 900, y: 900, width: 100, height: 100 },
  ];
  const fit = fitViewport(rooms, 350, 450);
  for (const room of rooms) {
    expect(fit.x + room.x * BASE_SCALE * fit.zoom).toBeGreaterThan(0);
    expect(fit.y + room.y * BASE_SCALE * fit.zoom).toBeGreaterThan(0);
    expect(fit.x + (room.x + room.width) * BASE_SCALE * fit.zoom).toBeLessThan(
      350,
    );
    expect(fit.y + (room.y + room.height) * BASE_SCALE * fit.zoom).toBeLessThan(
      450,
    );
  }
});
