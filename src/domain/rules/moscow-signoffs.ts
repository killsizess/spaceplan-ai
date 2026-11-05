import type { RuleSignoff } from "./types";

/**
 * A specialist's decisions on the Moscow rules, one rule at a time, keyed by rule id.
 * Empty until someone actually signs them off: the sign-off document lists the rules and
 * 31 test plans with a decision column, and each decision made there is entered here with
 * who made it and when. A confirmed rule may verify a conclusion; a rejected one is taken
 * out of the conclusions and listed as withdrawn. Never filled in from anyone's say-so.
 */
export const MOSCOW_SIGNOFFS: Readonly<Record<string, RuleSignoff>> = {};
