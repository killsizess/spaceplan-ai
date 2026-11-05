import type { BuildingFacts, FloorPlan } from "@/domain/floor-plan/types";

/** How sure the system is of a statement; the same four levels as the report. */
export type ConfidenceLevel = "specialist" | "undetermined" | "assumption" | "verified";
/** `problem` is something to fix or decide; `ok` holds; `note` is for information. */
export type FindingState = "problem" | "ok" | "note";

/**
 * What a piece of work takes, in the words of the rule base. There is deliberately no
 * "allowed": the most the system says is which procedure applies.
 * `unknown`: the answer depends on something the plan does not say.
 */
export type Procedure = "forbidden" | "specialist" | "project" | "simplified" | "unknown";

/** One document of a rule base, with what was actually read and what was not. */
export interface RegulationDocument {
  id: string;
  /** How a citation names it: «508-ПП». */
  short: string;
  title: string;
  /** The edition the rules were taken from. */
  edition: string;
  /** Where the text was read. */
  url: string;
  /** What is known to be missing from that reading; empty when nothing is. */
  gaps: string;
}

export interface RuleSource {
  document: string;
  /** The point within the document: «прил. 1, п. 9.16». */
  point: string;
}

export interface RuleFinding {
  ruleId: string;
  level: ConfidenceLevel;
  state: FindingState;
  procedure?: Procedure;
  title: string;
  detail?: string;
  wallIds?: readonly string[];
  roomIds?: readonly string[];
  openingIds?: readonly string[];
  /** Empty for a statement about missing data, which no document backs. */
  sources: readonly RuleSource[];
}

export type FactKey = Exclude<keyof BuildingFacts, "region">;

export interface RuleReport {
  packId: string;
  region: string;
  /** The date of this edition of the rule base. */
  version: string;
  /** False until a specialist has confirmed the rules. */
  reviewed: boolean;
  documents: readonly RegulationDocument[];
  notChecked: readonly string[];
  /** True when the plan is a variant whose source is known, so changes were checked. */
  checkedChanges: boolean;
  findings: readonly RuleFinding[];
  /** The heaviest procedure among the changes; null when nothing changed or no variant. */
  overall: Procedure | null;
  /** Questions about the building whose answers would change these findings. */
  missingFacts: readonly FactKey[];
}

export interface RulePack {
  id: string;
  region: string;
  version: string;
  reviewed: boolean;
  documents: readonly RegulationDocument[];
  notChecked: readonly string[];
  check(plan: FloorPlan): { findings: RuleFinding[]; missingFacts: FactKey[]; checkedChanges: boolean };
}
