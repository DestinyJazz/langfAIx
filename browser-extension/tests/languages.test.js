import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_LANGUAGE, LANGUAGE_GROUPS, allLanguages, fillLanguageSelect, languageName } from "../lib/languages.js";

// A fake page with just what fillLanguageSelect uses.
function fakeSelect() {
  const element = (tag) => ({
    tag,
    children: [],
    value: "",
    label: "",
    textContent: "",
    append(...nodes) {
      this.children.push(...nodes);
    },
  });
  const select = element("select");
  select.ownerDocument = { createElement: element };
  select.replaceChildren = function () {
    this.children = [];
  };
  // Every option, grouped or not.
  select.options = function () {
    return this.children.flatMap((child) => (child.tag === "optgroup" ? child.children : [child]));
  };
  return select;
}

test("the default language is in the list", () => {
  assert.equal(languageName(DEFAULT_LANGUAGE), "English (US)");
});

test("no language code is listed twice", () => {
  const codes = allLanguages().map((language) => language.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("every code looks like a LanguageTool language code and has a name", () => {
  for (const { code, name } of allLanguages()) {
    assert.match(code, /^[a-z]{2}(-[A-Z]{2})?(-[a-z]+)?$/, code);
    assert.ok(name.length > 0, code);
  }
});

test("the list holds English, Chinese and the languages with 3,000 or more rules", () => {
  assert.deepEqual(
    LANGUAGE_GROUPS.map((group) => group.group),
    ["English", "Chinese", "Catalan", "Dutch", "French", "German"],
  );
  assert.equal(languageName("zh-CN"), "Chinese (中文)");
});

test("the four kinds of English that were there before are still there", () => {
  for (const code of ["en-US", "en-GB", "en-AU", "en-CA"]) assert.ok(languageName(code), code);
});

test("German is only offered with a region, because plain 'de' gets no spell check", () => {
  const german = allLanguages().filter((language) => language.code.startsWith("de"));
  assert.ok(german.length > 0);
  for (const { code } of german) assert.match(code, /^de-[A-Z]{2}$/);
});

test("a code that is not in the list has no name", () => {
  assert.equal(languageName("xx-XX"), "");
  assert.equal(languageName(""), "");
});

test("the select gets one group per language and the current one is chosen", () => {
  const select = fakeSelect();
  fillLanguageSelect(select, "de-AT");
  assert.deepEqual(
    select.children.map((child) => [child.tag, child.label]),
    LANGUAGE_GROUPS.map((group) => ["optgroup", group.group]),
  );
  assert.equal(select.options().length, allLanguages().length);
  assert.equal(select.value, "de-AT");
});

test("filling the select twice does not double the options", () => {
  const select = fakeSelect();
  fillLanguageSelect(select, "en-US");
  fillLanguageSelect(select, "fr");
  assert.equal(select.options().length, allLanguages().length);
  assert.equal(select.value, "fr");
});

test("a stored code that is not in the list is kept, not silently replaced", () => {
  const select = fakeSelect();
  fillLanguageSelect(select, "es");
  assert.equal(select.value, "es");
  const extra = select.options().at(-1);
  assert.deepEqual([extra.value, extra.textContent], ["es", "es"]);
});

test("nothing stored means the default language", () => {
  const select = fakeSelect();
  fillLanguageSelect(select, "");
  assert.equal(select.value, DEFAULT_LANGUAGE);
  assert.equal(select.options().length, allLanguages().length);
});
