import accuracy from "./i18n-en/accuracy.json";
import editor1 from "./i18n-en/editor-1.json";
import editor2 from "./i18n-en/editor-2.json";
import editor3 from "./i18n-en/editor-3.json";
import plan from "./i18n-en/plan.json";
import rulesMoscow from "./i18n-en/rules-moscow.json";
import rulesOther from "./i18n-en/rules-other.json";
import rulesStatus from "./i18n-en/rules-status.json";
import screens from "./i18n-en/screens.json";
import templateBuyer from "./i18n-en/template-buyer.json";
import units from "./i18n-en/units.json";

/** Keyed by the Russian text in the code; `{0}` stands for the values, in the order they appear there. */
export const EN: Readonly<Record<string, string>> = {
  ...rulesMoscow,
  ...rulesOther,
  ...plan,
  ...screens,
  ...editor1,
  ...editor2,
  ...editor3,
  ...units,
  ...accuracy,
  ...rulesStatus,
  ...templateBuyer,
};
