/**
 * The language of the interface. Russian text in the code is the source and the key, the way
 * gettext works: `tr` returns it as written unless a dictionary is loaded, so with no
 * dictionary nothing changes. English is loaded before the app, and switching language reloads
 * the page, so that texts held in constants are simply evaluated in the right language once.
 */
export type Language = "ru" | "en";

const STORAGE_KEY = "spaceplan-ai:language:v1";
/** Browsers set to these read Russian; everyone else gets English. */
const RUSSIAN_READERS = ["ru", "be", "uk", "kk"];

let language: Language = "ru";
let dictionary: Readonly<Record<string, string>> | null = null;

export const currentLanguage = (): Language => language;
/** For numbers and dates. */
export const currentLocale = (): string => (language === "en" ? "en-US" : "ru-RU");

const isLanguage = (value: unknown): value is Language => value === "ru" || value === "en";

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(value: Language) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Blocked storage only means the choice is not remembered.
  }
}

/** A link's `?lang=` first, so a link can be shared; then the reader's choice; then the browser. */
export function detectLanguage(): Language {
  const asked = new URLSearchParams(window.location.search).get("lang");
  if (isLanguage(asked)) {
    store(asked);
    return asked;
  }
  const stored = readStored();
  if (isLanguage(stored)) return stored;
  const browser = (window.navigator.language || "").toLowerCase().split("-")[0];
  return RUSSIAN_READERS.includes(browser) ? "ru" : "en";
}

export function setDictionary(next: Language, entries: Readonly<Record<string, string>> | null) {
  language = next;
  dictionary = next === "ru" ? null : entries;
}

/** Runs before the app is imported: its constants read the language as they are evaluated. */
export async function prepareLanguage(): Promise<void> {
  const wanted = detectLanguage();
  if (wanted === "en") {
    const { EN } = await import("./i18n-en");
    setDictionary("en", EN);
  }
  document.documentElement.lang = wanted;
}

/** Remembers the choice and starts over in that language. Save the work first. */
export function chooseLanguage(next: Language) {
  store(next);
  const url = new URL(window.location.href);
  url.searchParams.delete("lang");
  window.location.replace(url);
}

const keys = new WeakMap<TemplateStringsArray, { key: string; before: string; after: string }>();
const warned = new Set<string>();

function keyOf(strings: TemplateStringsArray) {
  const known = keys.get(strings);
  if (known) return known;
  const whole = strings.reduce((all, part, index) => `${all}${index ? `{${index - 1}}` : ""}${part}`, "");
  const key = whole.trim();
  const start = whole.indexOf(key);
  const entry = { key, before: whole.slice(0, start), after: whole.slice(start + key.length) };
  keys.set(strings, entry);
  return entry;
}

/** Text for a person. Russian as written, or its translation with the same values filled in. */
export function tr(strings: TemplateStringsArray, ...values: unknown[]): string {
  if (dictionary) {
    const { key, before, after } = keyOf(strings);
    const translated = dictionary[key];
    if (translated !== undefined) {
      return before + translated.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)])) + after;
    }
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`No translation: ${key}`);
    }
  }
  return strings.reduce((all, part, index) => `${all}${index ? String(values[index - 1]) : ""}${part}`, "");
}

/**
 * Russian that must stay Russian: words the app reads rather than shows, such as the letters
 * of a Russian keyboard or the words of a developer's text.
 */
export const untranslated = <T extends string>(text: T): T => text;
