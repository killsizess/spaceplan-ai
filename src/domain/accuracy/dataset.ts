import { tr } from "@/lib/i18n";
import type { FloorPlan } from "@/domain/floor-plan/types";
import { roomsOfPlan } from "@/domain/rules/rule-rooms";
import {
  DEFAULT_ACCURACY_OPTIONS, measureAreas, measureOpenings, measureWalls, openingCenter,
  type AccuracyOptions, type AreaAccuracy, type OpeningAccuracy, type OpeningLike, type WallAccuracy, type WallLike,
} from "./recognition-accuracy";

/**
 * One plan of a measured set: what recognition proposed (kept in the plan when the
 * proposals were accepted) against what a person confirmed. The confirmed walls and
 * openings are the ones the developer confirmed when preparing the apartment, if they did;
 * otherwise the plan as saved, which is the person's corrected version.
 */
export interface PlanAccuracy {
  name: string;
  source: "pdf" | "dxf";
  appVersion: string;
  truth: "confirmed" | "saved";
  walls: WallAccuracy | null;
  doors: OpeningAccuracy | null;
  windows: OpeningAccuracy | null;
  areas: AreaAccuracy | null;
}

export type PlanAccuracyResult = PlanAccuracy | { name: string; skipped: string };

export function confirmedTruth(plan: FloorPlan): { walls: WallLike[]; openings: OpeningLike[]; truth: "confirmed" | "saved" } {
  const confirmed = (plan as FloorPlan & { template?: { confirmed?: { walls: WallLike[]; openings: OpeningLike[] } } }).template?.confirmed;
  if (confirmed) return { walls: confirmed.walls, openings: confirmed.openings, truth: "confirmed" };
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  return {
    walls: plan.walls,
    openings: plan.openings.flatMap((opening) => {
      const host = walls.get(opening.wallId);
      return host ? [{ kind: opening.kind, center: openingCenter(host, opening.offset, opening.width), width: opening.width }] : [];
    }),
    truth: "saved",
  };
}

export function measurePlan(
  name: string,
  plan: FloorPlan,
  documented: readonly { name: string; area: number }[] = [],
  options: AccuracyOptions = DEFAULT_ACCURACY_OPTIONS,
): PlanAccuracyResult {
  const record = plan.recognition;
  if (!record) return { name, skipped: tr`в плане нет записи распознавания: стены и проёмы добавлены не из предложений` };
  const truth = confirmedTruth(plan);
  const rooms = roomsOfPlan(plan);
  return {
    name,
    source: record.source,
    appVersion: record.appVersion,
    truth: truth.truth,
    walls: record.walls ? measureWalls(record.walls, truth.walls, options) : null,
    doors: record.openings ? measureOpenings(record.openings, truth.openings, "door", options) : null,
    windows: record.openings ? measureOpenings(record.openings, truth.openings, "window", options) : null,
    areas: documented.length && !rooms.unresolved ? measureAreas(rooms.rooms, documented) : null,
  };
}

export interface DatasetSummary {
  plans: number;
  skipped: number;
  /** Length-weighted over all plans: metres found of all confirmed metres. */
  wallRecall: number | null;
  wallPrecision: number | null;
  doorRecall: number | null;
  doorPrecision: number | null;
  windowRecall: number | null;
  windowPrecision: number | null;
  areaMeanAbsoluteShare: number | null;
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function summarizeDataset(results: readonly PlanAccuracyResult[]): DatasetSummary {
  const measured = results.filter((item): item is PlanAccuracy => !("skipped" in item));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const walls = measured.flatMap((item) => (item.walls ? [item.walls] : []));
  const openings = (kind: "doors" | "windows") => measured.flatMap((item) => (item[kind] ? [item[kind]!] : []));
  const areaShares = measured.flatMap((item) => item.areas?.rooms.flatMap((room) => (room.share === null ? [] : [Math.abs(room.share)])) ?? []);
  const of = (kind: "doors" | "windows") => {
    const list = openings(kind);
    return {
      recall: share(sum(list.map((item) => item.matched)), sum(list.map((item) => item.truthCount))),
      precision: share(sum(list.map((item) => item.matched)), sum(list.map((item) => item.foundCount))),
    };
  };
  return {
    plans: measured.length,
    skipped: results.length - measured.length,
    wallRecall: share(sum(walls.map((item) => (item.lengthRecall ?? 0) * item.truthLength)), sum(walls.map((item) => item.truthLength))),
    wallPrecision: share(sum(walls.map((item) => (item.lengthPrecision ?? 0) * item.foundLength)), sum(walls.map((item) => item.foundLength))),
    doorRecall: of("doors").recall,
    doorPrecision: of("doors").precision,
    windowRecall: of("windows").recall,
    windowPrecision: of("windows").precision,
    areaMeanAbsoluteShare: areaShares.length ? sum(areaShares) / areaShares.length : null,
  };
}

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 1000) / 10}%`);

/** The report as a Markdown table, for a person reading the results. */
export function accuracyReport(results: readonly PlanAccuracyResult[]): string {
  const summary = summarizeDataset(results);
  const lines = [
    tr`# Точность распознавания`,
    "",
    tr`Планов измерено: ${summary.plans}, пропущено: ${summary.skipped}.`,
    "",
    tr`| | Найдено (полнота) | Верно из предложенного (точность) |`,
    "|---|---|---|",
    tr`| Стены, по длине | ${percent(summary.wallRecall)} | ${percent(summary.wallPrecision)} |`,
    tr`| Двери | ${percent(summary.doorRecall)} | ${percent(summary.doorPrecision)} |`,
    tr`| Окна | ${percent(summary.windowRecall)} | ${percent(summary.windowPrecision)} |`,
    "",
    tr`Площади: средняя ошибка ${percent(summary.areaMeanAbsoluteShare)} от площади по документам.`,
    "",
    tr`## По планам`,
    "",
    tr`| План | Источник | Эталон | Стены: полнота / точность | Стен найдено / лишних | Двери | Окна | Площади |`,
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const item of results) {
    if ("skipped" in item) {
      lines.push(tr`| ${item.name} | — | — | пропущен: ${item.skipped} | | | | |`);
      continue;
    }
    const walls = item.walls;
    const openings = (value: OpeningAccuracy | null) => (value ? tr`${value.matched} из ${value.truthCount}, лишних ${value.foundCount - value.matched}` : "—");
    lines.push([
      "", item.name, item.source.toUpperCase(), item.truth === "confirmed" ? tr`подтверждено застройщиком` : tr`сохранённый план`,
      walls ? `${percent(walls.lengthRecall)} / ${percent(walls.lengthPrecision)}` : "—",
      walls ? tr`${walls.wallsFound} из ${walls.truthCount} / ${walls.wallsExtra}` : "—",
      openings(item.doors), openings(item.windows),
      item.areas ? tr`ошибка в среднем ${percent(item.areas.meanAbsoluteShare)}` : "—", "",
    ].join(" | ").trim());
  }
  return lines.join("\n") + "\n";
}
