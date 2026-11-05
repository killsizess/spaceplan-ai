import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { pluralRu } from "./format";
import { currentLanguage, setDictionary, tr, untranslated } from "./i18n";
import { EN } from "./i18n-en";

const CYRILLIC = /[А-Яа-яЁё]/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && !name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

/** Every `tr` key in the code, and every piece of Russian that does not go through `tr`. */
function scan() {
  const keys = new Set<string>();
  const loose: string[] = [];
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    if (!CYRILLIC.test(text)) continue;
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText();
        if (tag === "String.raw") return;
        if (tag === "tr") {
          const template = node.template;
          if (ts.isNoSubstitutionTemplateLiteral(template)) {
            keys.add(template.text.trim());
          } else {
            const parts = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
            keys.add(parts.reduce((all, part, index) => `${all}${index ? `{${index - 1}}` : ""}${part}`, "").trim());
            template.templateSpans.forEach((span) => visit(span.expression));
          }
          return;
        }
      }
      if (ts.isCallExpression(node) && node.expression.getText() === "untranslated") return;
      if (ts.isNewExpression(node) && node.expression.getText() === "RegExp") return;
      if (ts.isTypeNode(node)) return;
      const isText =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        node.kind === ts.SyntaxKind.JsxText ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (isText && CYRILLIC.test(node.getText())) loose.push(`${file}: ${node.getText().trim().slice(0, 70)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, loose };
}

const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort();

describe("the translation", () => {
  const { keys, loose } = scan();

  it("covers all Russian in the code, except what is marked as read rather than shown", () => {
    expect(loose).toEqual([]);
  });

  it("has an English text for every key", () => {
    expect([...keys].filter((key) => EN[key] === undefined)).toEqual([]);
  });

  it("has no entries the code no longer uses", () => {
    expect(Object.keys(EN).filter((key) => !keys.has(key))).toEqual([]);
  });

  it("has no Russian left in the English", () => {
    expect(Object.values(EN).filter((text) => CYRILLIC.test(text))).toEqual([]);
  });

  it("keeps the same values in every sentence", () => {
    const broken = Object.entries(EN).filter(([key, text]) => placeholders(key).join() !== placeholders(text).join());
    expect(broken).toEqual([]);
  });

  it("never says something is allowed where the Russian does not", () => {
    // The app names a procedure at most. Only a sentence saying the opposite may use these words,
    // and what the developer allowed a buyer to change in a template, which is not a legal claim.
    const developerPermission = /developer allowed|allowed (partition|room)s?\b/gi;
    const claims = Object.values(EN).filter((text) => {
      const rest = text.replace(developerPermission, "");
      return /\b(allowed|permitted|legal)\b/i.test(rest) && !/\bnot\b/i.test(rest);
    });
    expect(claims.filter((text) => !/up to 40 megapixels/.test(text))).toEqual([]);
  });
});

describe("tr", () => {
  afterEach(() => setDictionary("ru", null));

  it("returns Russian as written when no dictionary is loaded", () => {
    const wall = 5;
    expect(currentLanguage()).toBe("ru");
    expect(tr`Стена ${wall}`).toBe("Стена 5");
  });

  it("translates with values in place, reordered if the English needs it", () => {
    setDictionary("en", { "{0} из {1}": "{1}: {0}" });
    const [part, whole] = [1, 2];
    expect(tr`${part} из ${whole}`).toBe("2: 1");
  });

  it("keeps the spaces around a piece of a sentence", () => {
    setDictionary("en", { "из": "of" });
    expect(tr` из `).toBe(" of ");
  });

  it("falls back to Russian rather than showing nothing", () => {
    setDictionary("en", {});
    expect(tr`Нет такого`).toBe("Нет такого");
  });

  it("leaves what is read rather than shown", () => {
    setDictionary("en", { "ё": "e" });
    expect(untranslated("ё")).toBe("ё");
  });

  it("counts in English with English plurals", () => {
    setDictionary("en", {});
    expect(pluralRu(1, "wall", "walls", "walls")).toBe("1 wall");
    expect(pluralRu(2, "wall", "walls", "walls")).toBe("2 walls");
    setDictionary("ru", null);
    expect(pluralRu(2, "стена", "стены", "стен")).toBe("2 стены");
  });
});
