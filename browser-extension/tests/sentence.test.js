// Tests for sentence ranges and for finding the sentence at a position.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sentenceAt, sentenceRanges } from "../lib/sentence.js";

const cut = (text, range) => text.slice(range.offset, range.offset + range.length);

test("ranges from the server are used as they are", () => {
  const text = "First one. Second one.";
  const ranges = sentenceRanges(text, [
    { offset: 0, length: 10 },
    { offset: 11, length: 11 },
  ]);
  assert.deepEqual(ranges.map((r) => cut(text, r)), ["First one.", "Second one."]);
});

test("ranges are sorted and bad ones are dropped", () => {
  const text = "First one. Second one.";
  const ranges = sentenceRanges(text, [
    { offset: 11, length: 11 },
    { offset: 0, length: 10 },
    { offset: 5, length: 999 }, // beyond the end of the text
    { offset: -1, length: 3 },
    { offset: 2, length: 0 },
  ]);
  assert.deepEqual(ranges.map((r) => cut(text, r)), ["First one.", "Second one."]);
});

test("an older server without sentence ranges falls back to lines", () => {
  // Two sentences on one line count as one piece; the backend splits again.
  const text = "  One. Two.\n\nThree.  ";
  for (const sentences of [undefined, null, []]) {
    const ranges = sentenceRanges(text, sentences);
    assert.deepEqual(ranges.map((r) => cut(text, r)), ["One. Two.", "Three."]);
  }
});

test("empty text has no sentences", () => {
  assert.deepEqual(sentenceRanges("", undefined), []);
  assert.deepEqual(sentenceRanges("   \n ", undefined), []);
});

test("sentenceAt finds the sentence that contains a position", () => {
  const ranges = [
    { offset: 0, length: 10 },
    { offset: 11, length: 11 },
  ];
  assert.equal(sentenceAt(ranges, 0), ranges[0]);
  assert.equal(sentenceAt(ranges, 9), ranges[0]);
  assert.equal(sentenceAt(ranges, 11), ranges[1]);
  assert.equal(sentenceAt(ranges, 21), ranges[1]);
});

test("a position between two sentences belongs to the one before", () => {
  const ranges = [
    { offset: 0, length: 10 },
    { offset: 12, length: 10 },
  ];
  assert.equal(sentenceAt(ranges, 10), ranges[0]);
  assert.equal(sentenceAt(ranges, 11), ranges[0]);
});

test("positions outside every sentence still give the nearest one", () => {
  const ranges = [
    { offset: 3, length: 5 },
    { offset: 10, length: 5 },
  ];
  assert.equal(sentenceAt(ranges, 0), ranges[0]); // before the first sentence
  assert.equal(sentenceAt(ranges, 99), ranges[1]); // after the last sentence
});

test("no sentences means no result", () => {
  assert.equal(sentenceAt([], 3), null);
  assert.equal(sentenceAt(undefined, 3), null);
});

// ---------- Free hints ----------

import { findHints, hintReason } from "../lib/sentence.js";

const issue = (offset, extra = {}) => ({ offset, length: 3, issue_type: "grammar", category: "GRAMMAR", ...extra });

test("a sentence with two or more issues gets a hint", () => {
  // "are" (at 5) and "sentense" (at 16) are two places.
  assert.equal(hintReason("This are a test sentense for you.", [issue(5), issue(16, { length: 8 })]), "issues");
});

test("issues right next to each other count as one place", () => {
  // LanguageTool reports "This are" as This and are: really one error.
  const thisAre = [issue(0, { length: 4 }), issue(5)];
  assert.equal(hintReason("This are the second line with a mistake.", thisAre), "");
  // Only with another error elsewhere are there two places.
  assert.equal(hintReason("This are the second line with a mistaek.", [...thisAre, issue(32, { length: 7 })]), "issues");
  // Two overlapping issues count as one place as well.
  assert.equal(hintReason("This editor have a mistake in it.", [issue(0, { length: 16 }), issue(12, { length: 4 })]), "");
});

test("misspelled words next to each other are separate mistakes", () => {
  // Three typos in a row are three errors, not one. Found missing in a TinyMCE screenshot.
  const typo = (offset, length) => issue(offset, { length, issue_type: "misspelling", category: "TYPOS" });
  const typos = [typo(18, 8), typo(27, 5), typo(33, 6)];
  assert.equal(hintReason("Please review the documant befor friday.", typos), "issues");
  // A typo right next to a grammar issue is two errors too.
  assert.equal(hintReason("Thiss are a good plan for us.", [typo(0, 5), issue(6)]), "issues");
});

test("a sentence with one ordinary issue gets no hint", () => {
  // A single issue is fixed by clicking its red line; no need for the AI.
  assert.equal(hintReason("This is a test sentense for you.", [issue(15)]), "");
});

test("a style issue is enough for a hint", () => {
  assert.equal(hintReason("In order to do this we need more time.", [issue(0, { issue_type: "style", category: "STYLE" })]), "style");
  assert.equal(hintReason("In order to do this we need more time.", [issue(0, { category: "REDUNDANCY" })]), "style");
  assert.equal(hintReason("In order to do this we need more time.", [issue(0, { category: "PLAIN_ENGLISH" })]), "style");
});

test("a long sentence gets a hint even without any issue", () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ") + ".";
  assert.equal(hintReason(long, []), "long");
  const notLong = Array.from({ length: 29 }, (_, i) => `word${i}`).join(" ") + ".";
  assert.equal(hintReason(notLong, []), "");
});

test("a very short sentence never gets a hint", () => {
  assert.equal(hintReason("Teh erors here.", [issue(0), issue(4)]), "");
});

test("a clean ordinary sentence gets no hint", () => {
  assert.equal(hintReason("The server blocks this traffic by default.", []), "");
});

test("findHints looks at each sentence with its own issues", () => {
  //            0         1         2         3         4         5         6         7
  //            0123456789012345678901234567890123456789012345678901234567890123456789012345678
  const text = "This are a test sentense for you. The second sentence here is perfectly fine.";
  const ranges = [
    { offset: 0, length: 33 },
    { offset: 34, length: 43 },
  ];
  const matches = [issue(0), issue(5), issue(16)];

  const hints = findHints(text, ranges, matches);

  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0], { offset: 0, length: 33, text: "This are a test sentense for you.", reason: "issues" });
});

test("issues are counted only in their own sentence", () => {
  // One issue in each of two sentences: neither reaches two, so no hint.
  const text = "This are a good plan for us. That plan have a problem though.";
  const ranges = [
    { offset: 0, length: 28 },
    { offset: 29, length: 32 },
  ];
  assert.deepEqual(findHints(text, ranges, [issue(5), issue(39)]), []);
});

test("sentences that should be skipped are skipped", () => {
  const text = "This are a test sentense for you.";
  const ranges = [{ offset: 0, length: 33 }];
  const matches = [issue(5), issue(16, { length: 8 })];
  // E.g. the AI already looked at this sentence, or the user dismissed it.
  assert.deepEqual(findHints(text, ranges, matches, (sentence) => sentence === text), []);
  assert.equal(findHints(text, ranges, matches, () => false).length, 1);
});

test("no ranges means no hints", () => {
  assert.deepEqual(findHints("Some text.", [], []), []);
  assert.deepEqual(findHints("Some text.", undefined, undefined), []);
});
