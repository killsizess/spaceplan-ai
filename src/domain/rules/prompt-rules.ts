import type { ProfileRule, ProfileTarget, RuleProfile } from "@/domain/floor-plan/types";

/**
 * Reads a developer's text into rules the engine can check. This is pattern matching, not
 * an AI model, and it says so on the screen: it knows Russian and English phrasings of the
 * rules below, and whatever it does not recognise comes back as not understood instead of
 * being guessed at. A language model can later replace `interpretPrompt` behind the same
 * result; it would still only propose rules, and the engine would still do the checking.
 */
const TARGETS: readonly { target: ProfileTarget; pattern: RegExp }[] = [
  { target: "kitchen", pattern: /кухн\S*|kitchens?/g },
  { target: "bedroom", pattern: /спальн\S*(?:\s+комнат\S*)?|bedrooms?/g },
  { target: "living", pattern: /гостин\S*(?:\s+комнат\S*)?|living\s*rooms?|lounges?/g },
  { target: "bathroom", pattern: /санузл\S*|санузел|ванн\S*(?:\s+комнат\S*)?|туалет\S*|уборн\S*|bathrooms?|toilets?|washrooms?/g },
  { target: "hall", pattern: /прихож\S*|коридор\S*|halls?(?![a-z])|corridors?/g },
  { target: "balcony", pattern: /балкон\S*|лоджи\S*|balcon\S*|loggias?/g },
  { target: "shaft", pattern: /шахт\S*|короб\S*|shafts?|ducts?/g },
  { target: "any-living", pattern: /(?:жил\S*\s+)?комнат\S*|rooms?(?![a-z])/g },
];

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const MAX_WORDS = String.raw`не\s+больше|не\s+более|максимум|at\s+most|no\s+more\s+than|not\s+more\s+than|maximum|max|<=|≤|(?:^|[^а-я])до(?=\s)`;
const MIN_WORDS = String.raw`не\s+меньше|не\s+менее|не\s+ниже|как\s+минимум|минимум|больше|at\s+least|no\s+less\s+than|not\s+less\s+than|more\s+than|minimum|min|>=|≥|(?:^|[^а-я])от(?=\s)`;
const MAX_VALUE = new RegExp(`(?:${MAX_WORDS})\\D{0,12}?${NUMBER}`);
const MIN_VALUE = new RegExp(`(?:${MIN_WORDS})\\D{0,12}?${NUMBER}`);
const MIN_BEFORE = /минимальн|наименьш|minimum|smallest/;
const MAX_BEFORE = /максимальн|наибольш|maximum|largest/;
const FORBID = /нельзя|запрещ|не\s+допуск|не\s+надо|не\s+должн|do\s+not|don'?t|must\s+not|should\s+not|not\s+allowed|forbidden|prohibited|never/;
const COUNT_WORDS: Readonly<Record<string, number>> = {
  один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трёх: 3, трех: 3, четыре: 4, четырех: 4, пять: 5,
  one: 1, two: 2, three: 3, four: 4, five: 5,
};
const COUNT = new RegExp(
  `(не\\s+больше|не\\s+более|максимум|at\\s+most|no\\s+more\\s+than|maximum|не\\s+меньше|не\\s+менее|минимум|как\\s+минимум|at\\s+least|minimum)?\\s*(?:^|\\s)(\\d+|${Object.keys(COUNT_WORDS).join("|")})\\s+$`,
);

const number = (text: string) => Number(text.replace(",", "."));

interface FoundTarget {
  target: ProfileTarget;
  start: number;
  end: number;
}

/** The room kinds a clause names, in order; a longer, more specific name wins its words. */
function findTargets(clause: string): FoundTarget[] {
  let rest = clause;
  const found: FoundTarget[] = [];
  for (const { target, pattern } of TARGETS) {
    for (const match of rest.matchAll(pattern)) {
      found.push({ target, start: match.index, end: match.index + match[0].length });
    }
    rest = rest.replace(pattern, (words) => " ".repeat(words.length));
  }
  return found.sort((a, b) => a.start - b.start);
}

type RuleDraft = { [K in ProfileRule["type"]]: Omit<Extract<ProfileRule, { type: K }>, "id" | "phrase"> }[ProfileRule["type"]];

function readClause(clause: string): RuleDraft[] {
  const targets = findTargets(clause);

  // Ceiling height.
  if (/высот|потолк|ceiling|height/.test(clause)) {
    const value = clause.match(MIN_VALUE);
    return value ? [{ type: "min-height", value: number(value[1]) }] : [];
  }

  // A window in a room.
  if (/окн|window/.test(clause)) {
    if (/без\s+окн|without\s+(?:a\s+)?window|no\s+window/.test(clause)) return [];
    // Only an obligation is a rule: "вид из окна важен" says nothing about what to check.
    if (!/кажд|(?:^|[^а-я])все(?:[^а-я]|$)|должн|нужн|обязат|с\s+окн|окно\s+в|must|every|each|all\s|have|needs?|requires?/.test(clause)) return [];
    const rooms = targets.length ? targets.map((item) => item.target) : (["any-living"] as ProfileTarget[]);
    return [...new Set(rooms)].map((target) => ({ type: "window-required", target }));
  }

  // Bearing walls stay as they are.
  if (/несущ|load[-\s]?bearing|bearing|structural/.test(clause)) {
    return FORBID.test(clause) || /не\s+(?:трогать|менять|сносить|переносить|изменять)|keep|leave|untouched/.test(clause)
      ? [{ type: "keep-bearing" }]
      : [];
  }

  // Two kinds of room must not become one.
  if (/объедин|совмещ|merg|combin|join/.test(clause)) {
    if (!FORBID.test(clause) && !/не\s+объедин|не\s+совмещ/.test(clause)) return [];
    const [first, ...others] = targets;
    if (!first || !others.length) return [];
    return others.map((other) => ({ type: "no-merge", target: first.target, other: other.target }));
  }

  // A room stays where it is.
  const wet = /мокр\S*\s+зон|wet\s+(?:area|room|zone)s?/.test(clause);
  if ((targets.length || wet) && /перенос|перемещ|двига|на\s+месте|на\s+своих\s+местах|\bmove|moved|stay|relocat/.test(clause)) {
    if (!FORBID.test(clause) && !/не\s+(?:перенос|перемещ|двига)|на\s+месте|на\s+своих\s+местах|stay/.test(clause)) return [];
    const rooms: ProfileTarget[] = wet ? ["bathroom", "kitchen"] : targets.map((item) => item.target);
    return [...new Set(rooms)].map((target) => ({ type: "keep-room", target }));
  }

  // Any change needs a project.
  if (/по\s+проекту|нужен\s+проект|требуется\s+проект|(?:requires?|needs?)\s+(?:a\s+)?(?:permit|project|approval)|only\s+with\s+(?:a\s+)?(?:permit|project|approval)/.test(clause)) {
    return [{ type: "project-required" }];
  }

  const rules: RuleDraft[] = [];
  targets.forEach((item, index) => {
    // How many rooms of a kind: the count stands right before the room's name.
    const before = clause.slice(index ? targets[index - 1].end : 0, item.start);
    const count = before.match(COUNT);
    if (count) {
      const raw = count[2];
      const value = /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS[raw];
      const word = count[1] ?? "";
      if (/больше|более|максимум|at\s+most|no\s+more|maximum/.test(word)) rules.push({ type: "room-count", target: item.target, max: value });
      else if (word) rules.push({ type: "room-count", target: item.target, min: value });
      else rules.push({ type: "room-count", target: item.target, min: value, max: value });
    }

    // How large a room is: the limit stands after the room's name.
    const after = clause.slice(item.end, targets[index + 1]?.start ?? clause.length);
    const lead = clause.slice(0, item.start);
    const upper = after.match(MAX_VALUE);
    const lower = upper ? null : after.match(MIN_VALUE);
    const bare = after.match(new RegExp(NUMBER));
    if (upper) rules.push({ type: "room-max-area", target: item.target, value: number(upper[1]) });
    else if (lower) rules.push({ type: "room-min-area", target: item.target, value: number(lower[1]) });
    else if (bare && MIN_BEFORE.test(lead)) rules.push({ type: "room-min-area", target: item.target, value: number(bare[1]) });
    else if (bare && MAX_BEFORE.test(lead)) rules.push({ type: "room-max-area", target: item.target, value: number(bare[1]) });
  });
  return rules;
}

export function interpretPrompt(prompt: string): RuleProfile {
  const rules: ProfileRule[] = [];
  const notUnderstood: string[] = [];
  const sentences = prompt
    .split(/\n+|[.;!?]+(?=\s|$)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    for (const clause of sentence.split(/,\s+/).map((part) => part.trim()).filter(Boolean)) {
      const drafts = readClause(clause.toLowerCase().replaceAll("ё", "е"));
      if (!drafts.length) {
        notUnderstood.push(clause);
        continue;
      }
      for (const draft of drafts) rules.push({ ...draft, id: `r${rules.length + 1}`, phrase: clause } as ProfileRule);
    }
  }
  return { prompt, rules, notUnderstood };
}
