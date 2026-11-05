import { z } from "zod";
import {
  assertRectangle,
  MAX_COORDINATE,
  MAX_PLAN_DIMENSION,
  MAX_ROOM_SIZE,
  MIN_ROOM_SIZE,
  wallLength,
} from "@/domain/geometry";
import { checkPlanRelations } from "./plan-integrity";
import type { FloorPlan } from "./types";

export { MAX_PLAN_DIMENSION };

const id = z.string().min(1).max(100);
const coordinate = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const size = z.number().finite().min(MIN_ROOM_SIZE).max(MAX_ROOM_SIZE);
const positive = z.number().finite().positive().max(MAX_ROOM_SIZE);
const pointSchema = z.object({ x: coordinate, y: coordinate }).strict();
export const MAX_UNDERLAY_DATA_URL_LENGTH = 2 * 1024 * 1024;
export const MAX_UNDERLAY_PIXELS = 4096;

export const underlaySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    dataUrl: z
      .string()
      .max(MAX_UNDERLAY_DATA_URL_LENGTH)
      .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
    pixelWidth: z.number().int().min(1).max(MAX_UNDERLAY_PIXELS),
    pixelHeight: z.number().int().min(1).max(MAX_UNDERLAY_PIXELS),
    x: coordinate,
    y: coordinate,
    metersPerPixel: z.number().finite().positive().max(MAX_PLAN_DIMENSION),
    opacity: z.number().finite().min(0).max(1),
    visible: z.boolean(),
    calibrated: z.boolean(),
  })
  .strict()
  .superRefine((underlay, ctx) => {
    const width = underlay.pixelWidth * underlay.metersPerPixel;
    const height = underlay.pixelHeight * underlay.metersPerPixel;
    if (
      width > MAX_PLAN_DIMENSION ||
      height > MAX_PLAN_DIMENSION ||
      underlay.x + width > MAX_COORDINATE ||
      underlay.y + height > MAX_COORDINATE
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Подложка выходит за пределы ±1000 м. Уменьшите масштаб или измените положение.",
      });
    }
    const prefixLength = underlay.dataUrl.indexOf(",") + 1;
    if ((underlay.dataUrl.length - prefixLength) % 4 !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "Повреждённые данные изображения подложки.",
      });
    }
  });

export const roomSchema = z
  .object({
    id,
    name: z
      .string()
      .trim()
      .min(1, "Введите название комнаты.")
      .max(60, "Название — не больше 60 символов."),
    kind: z.enum(["living", "bedroom", "kitchen", "bathroom", "hall", "other", "balcony", "shaft"]),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    x: coordinate,
    y: coordinate,
    width: size,
    height: size,
  })
  .strict()
  .superRefine((room, ctx) => {
    try {
      assertRectangle(room);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Некорректная комната.",
      });
    }
  });

export const wallSchema = z
  .object({
    id,
    start: pointSchema,
    end: pointSchema,
    thickness: positive,
    height: positive,
    kind: z.enum(["bearing", "partition", "unknown"]).optional(),
  })
  .strict()
  .superRefine((wall, ctx) => {
    try {
      if (wallLength(wall.start, wall.end) > MAX_PLAN_DIMENSION) {
        ctx.addIssue({
          code: "custom",
          message: "Длина стены не должна превышать 2000 м.",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Стена должна иметь ненулевую длину и корректные координаты.",
      });
    }
  });
export const openingSchema = z
  .object({
    id,
    wallId: id,
    kind: z.enum(["door", "window"]),
    offset: z.number().finite().min(0).max(MAX_PLAN_DIMENSION),
    width: z.number().finite().positive().max(MAX_PLAN_DIMENSION),
    height: positive,
    sillHeight: z.number().finite().min(0).max(MAX_ROOM_SIZE),
    door: z.object({
      hinge: z.enum(["start", "end"]),
      side: z.enum(["left", "right"]),
    }).strict().optional(),
    doorless: z.literal(true).optional(),
  })
  .strict()
  .superRefine((opening, ctx) => {
    if (opening.kind !== "door" && "doorless" in opening) {
      ctx.addIssue({
        code: "custom",
        path: ["doorless"],
        message: "Проём без двери бывает только на месте двери.",
      });
    }
    if (opening.kind !== "door" && "door" in opening) {
      ctx.addIssue({
        code: "custom",
        path: ["door"],
        message: "Направление открывания можно задать только для двери.",
      });
    }
  });

export const wallRoomLabelSchema = z.object({
  id,
  name: z.string().trim().min(1, "Введите название помещения.").max(60, "Название — не больше 60 символов."),
  kind: z.enum(["living", "bedroom", "kitchen", "bathroom", "hall", "other", "balcony", "shaft"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  anchor: pointSchema,
  boundaryWallIds: z.array(id).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "Границы помещения не должны повторяться."),
}).strict();

const roomKind = z.enum(["living", "bedroom", "kitchen", "bathroom", "hall", "other", "balcony", "shaft"]);
export const planRequirementSchema = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("room-min-area"),
    kind: roomKind,
    minArea: z.number().finite().positive("Площадь должна быть больше 0 м².").max(10000, "Площадь — не больше 10 000 м²."),
    labelId: id.optional(),
  }).strict(),
  z.object({
    id,
    type: z.literal("room-max-area"),
    kind: roomKind,
    maxArea: z.number().finite().positive("Площадь должна быть больше 0 м².").max(10000, "Площадь — не больше 10 000 м²."),
    labelId: id.optional(),
  }).strict(),
  z.object({
    id,
    type: z.literal("wall-fixed"),
    wallId: id,
    start: pointSchema,
    end: pointSchema,
    thickness: positive,
  }).strict(),
  z.object({ id, type: z.literal("room-not-walkthrough"), kind: roomKind, labelId: id.optional() }).strict(),
  z.object({ id, type: z.literal("rooms-connected"), kind: roomKind, otherKind: roomKind, byDoor: z.boolean() }).strict(),
  z.object({
    id,
    type: z.literal("bearing-walls-kept"),
    walls: z.array(z.object({ wallId: id, start: pointSchema, end: pointSchema, thickness: positive }).strict())
      .min(1, "Отметьте хотя бы одну несущую стену.")
      .max(1000)
      .refine((walls) => new Set(walls.map((wall) => wall.wallId)).size === walls.length, "Стены в требовании не должны повторяться."),
  }).strict(),
]);

/** Geometry kept with a variant; field rules only, relations belong to the plan itself. */
export const planSnapshotSchema = z.object({
  roomMode: z.enum(["manual", "walls"]),
  rooms: z.array(roomSchema).max(100),
  walls: z.array(wallSchema).max(1000),
  openings: z.array(openingSchema).max(1000),
  wallRoomLabels: z.array(wallRoomLabelSchema).max(100),
  requirements: z.array(planRequirementSchema).max(50),
}).strict();

export const planOriginSchema = z.object({
  planId: id,
  planName: z.string().trim().min(1).max(100),
  createdAt: z.string().datetime(),
  snapshot: planSnapshotSchema,
}).strict();

const neighbourFloorSchema = z.enum(["same-layout", "other-layout", "no-dwelling"]);

export const buildingFactsSchema = z.object({
  region: z.enum(["moscow", "other"]).optional(),
  gasified: z.boolean().optional(),
  woodenFloors: z.boolean().optional(),
  heritage: z.boolean().optional(),
  emergency: z.boolean().optional(),
  below: neighbourFloorSchema.optional(),
  above: neighbourFloorSchema.optional(),
  floorLevel: z.enum(["first", "upper"]).optional(),
}).strict();

const profileTarget = z.enum(["living", "bedroom", "kitchen", "bathroom", "hall", "other", "balcony", "shaft", "any-living"]);
const profileRuleBase = { id, phrase: z.string().trim().min(1).max(500) };
const profileNumber = z.number().finite().positive().max(10000);

export const ruleProfileSchema = z.object({
  prompt: z.string().max(5000),
  rules: z.array(z.discriminatedUnion("type", [
    z.object({ ...profileRuleBase, type: z.literal("room-min-area"), target: profileTarget, value: profileNumber }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("room-max-area"), target: profileTarget, value: profileNumber }).strict(),
    z.object({
      ...profileRuleBase,
      type: z.literal("room-count"),
      target: profileTarget,
      min: z.number().int().min(0).max(100).optional(),
      max: z.number().int().min(0).max(100).optional(),
    }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("min-height"), value: profileNumber }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("window-required"), target: profileTarget }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("no-merge"), target: profileTarget, other: profileTarget }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("keep-bearing") }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("keep-room"), target: profileTarget }).strict(),
    z.object({ ...profileRuleBase, type: z.literal("project-required") }).strict(),
  ])).max(100),
  notUnderstood: z.array(z.string().max(500)).max(100),
}).strict();

const floorPlanFields = z
  .object({
    schemaVersion: z.literal(10),
    unit: z.literal("m"),
    id,
    name: z.string().trim().min(1).max(100),
    roomMode: z.enum(["manual", "walls"]),
    rooms: z.array(roomSchema).max(100),
    walls: z.array(wallSchema).max(1000),
    openings: z.array(openingSchema).max(1000),
    wallRoomLabels: z.array(wallRoomLabelSchema).max(100, "В одном плане может быть не больше 100 подписей помещений."),
    requirements: z.array(planRequirementSchema).max(50, "В одном плане может быть не больше 50 требований."),
    underlay: underlaySchema.optional(),
    origin: planOriginSchema.optional(),
    buildingFacts: buildingFactsSchema.optional(),
    ruleProfile: ruleProfileSchema.optional(),
  })
  .strict();

type FloorPlanFields = z.infer<typeof floorPlanFields>;

/**
 * Field rules describe single objects; relations between objects (IDs, overlaps,
 * references, wall rooms) have one source of truth, `checkPlanRelations`.
 */
function relationRefinement(allowUnresolvedRooms: boolean) {
  return (plan: FloorPlanFields, ctx: z.RefinementCtx) => {
    for (const issue of checkPlanRelations(plan as FloorPlan, { allowUnresolvedRooms })) {
      ctx.addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
    }
  };
}

/** Every edit and every new plan: wall rooms must be computable. */
export const floorPlanSchema = floorPlanFields.superRefine(relationRefinement(false));

/**
 * Opening a saved or imported project. The same rules, except that wall rooms which
 * cannot be computed (too many rooms, a degenerate contour) do not make the project
 * unreadable: it opens unchanged and the editor says what is wrong. Editing still
 * goes through `floorPlanSchema`, so a plan like this cannot be produced by an edit.
 */
export const floorPlanLoadSchema = floorPlanFields.superRefine(relationRefinement(true));
