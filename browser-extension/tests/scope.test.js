// Tests for which text each of the three badge-menu choices would send.

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_AI_CHARS, MAX_AI_SENTENCES, blockedReason, buildScopes } from "../lib/scope.js";

const cut = (text, scope) => text.slice(scope.offset, scope.offset + scope.length);

//            0         1         2         3         4
//            012345678901234567890123456789012345678901234
const TEXT = "First one here. Second one here. Third one.";
const RANGES = [
  { offset: 0, length: 15 },
  { offset: 16, length: 16 },
  { offset: 33, length: 10 },
];

test("the sentence option is the sentence the caret is in", () => {
  const scopes = buildScopes(TEXT, RANGES, { start: 20, end: 20 });
  assert.equal(cut(TEXT, scopes.sentence), "Second one here.");
  assert.equal(scopes.sentence.sentences, 1);
  assert.equal(scopes.sentence.blocked, "");
});

test("without a selection there is no selection option", () => {
  assert.equal(buildScopes(TEXT, RANGES, { start: 20, end: 20 }).selection, null);
  assert.equal(buildScopes(TEXT, RANGES, null).selection, null);
});

test("the selection option is exactly what was selected, without the spaces around it", () => {
  // " one here. Second one " is selected, with a space at each end.
  const scopes = buildScopes(TEXT, RANGES, { start: 5, end: 27 });
  assert.equal(cut(TEXT, scopes.selection), "one here. Second one");
  assert.equal(scopes.selection.sentences, 2); // touches two sentences
});

test("selecting only spaces gives no selection option", () => {
  const text = "One.   Two.";
  assert.equal(buildScopes(text, [{ offset: 0, length: 4 }, { offset: 7, length: 4 }], { start: 4, end: 7 }).selection, null);
});

test("the whole-text option covers everything except the blank ends", () => {
  const text = "  One here.\nTwo here.\n\n";
  const ranges = [
    { offset: 2, length: 9 },
    { offset: 12, length: 9 },
  ];
  const scopes = buildScopes(text, ranges, null);
  assert.equal(cut(text, scopes.all), "One here.\nTwo here.");
  assert.equal(scopes.all.sentences, 2);
});

test("an empty box has no options at all", () => {
  assert.deepEqual(buildScopes("", [], null), { sentence: null, selection: null, all: null });
  assert.deepEqual(buildScopes("   ", [], { start: 1, end: 1 }), { sentence: null, selection: null, all: null });
});

test("text over the character limit cannot be sent", () => {
  const text = "word ".repeat(MAX_AI_CHARS / 5 + 1).trim(); // a few characters over the limit
  const scopes = buildScopes(text, [{ offset: 0, length: text.length }], null);
  assert.match(scopes.all.blocked, /^Too long: 5,00\d characters \(the limit is 5,000\)\.$/);
});

test("too many sentences cannot be sent", () => {
  const count = MAX_AI_SENTENCES + 1;
  const text = "Ok. ".repeat(count).trim();
  const ranges = Array.from({ length: count }, (_, i) => ({ offset: i * 4, length: 3 }));
  const scopes = buildScopes(text, ranges, { start: 0, end: 0 });
  assert.equal(scopes.all.blocked, "Too many sentences: 31 (the limit is 30).");
  // The sentence at the caret is itself within the limit and can still be sent.
  assert.equal(scopes.sentence.blocked, "");
});

test("exactly at the limits is still allowed", () => {
  assert.equal(blockedReason(MAX_AI_CHARS, MAX_AI_SENTENCES), "");
});
