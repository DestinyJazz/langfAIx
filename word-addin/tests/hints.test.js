// Tests for which lines a paragraph gets: red lines, and lavender hint lines that break at red ones.
// Run with npm test in the word-addin folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { layersFor } from "../lib/hints.js";

// A rule issue: finds word in text.
const issue = (text, word, type = "misspelling") => ({ start: text.indexOf(word), length: word.length, match: { text: word, issue_type: type, rule_id: "R" } });
// The whole text is one sentence.
const whole = (text) => [{ offset: 0, length: text.length }];
const pieceTexts = (text, hint) => hint.pieces.map((piece) => text.slice(piece.start, piece.start + piece.length));

test("a sentence with two mistakes gets a hint, broken where the red lines are", () => {
  const text = "This sentense has a mistaek today.";
  const { hints } = layersFor(text, [issue(text, "sentense"), issue(text, "mistaek")], whole(text));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].reason, "issues");
  assert.equal(hints[0].text, text);
  // The lavender line is three pieces that skip both red lines. Pieces of only spaces and punctuation are not drawn.
  assert.deepEqual(pieceTexts(text, hints[0]), ["This ", " has a ", " today."]);
  // No piece overlaps a red line.
  for (const piece of hints[0].pieces) {
    for (const word of ["sentense", "mistaek"]) {
      const at = text.indexOf(word);
      assert.ok(piece.start + piece.length <= at || piece.start >= at + word.length, `a hint piece overlaps ${word}`);
    }
  }
});

test("a sentence with one ordinary mistake gets no hint", () => {
  const text = "This sentense is fine otherwise.";
  assert.deepEqual(layersFor(text, [issue(text, "sentense")], whole(text)).hints, []);
});

test("a very long sentence without mistakes gets one unbroken hint", () => {
  const text = `${"word ".repeat(31).trim()}.`;
  const { hints } = layersFor(text, [], whole(text));
  assert.equal(hints[0].reason, "long");
  assert.deepEqual(hints[0].pieces, [{ start: 0, length: text.length }]);
});

test("only the sentence that needs it is hinted, positions stay inside the paragraph", () => {
  const first = "A short fine one here.";
  const second = "This sentense has a mistaek today.";
  const text = `${first} ${second}`;
  const sentences = [
    { offset: 0, length: first.length },
    { offset: first.length + 1, length: second.length },
  ];
  const { hints } = layersFor(text, [issue(text, "sentense"), issue(text, "mistaek")], sentences);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].offset, first.length + 1);
  assert.deepEqual(pieceTexts(text, hints[0]), ["This ", " has a ", " today."]);
});

test("sentences the user does not want hinted are skipped", () => {
  const text = "This sentense has a mistaek today.";
  const { hints, issues } = layersFor(text, [issue(text, "sentense"), issue(text, "mistaek")], whole(text), (sentence) => sentence === text);
  assert.deepEqual(hints, []);
  assert.equal(issues.length, 2); // red lines are unaffected
});

test("without sentence boundaries there are no hints", () => {
  const text = "This sentense has a mistaek today.";
  assert.deepEqual(layersFor(text, [issue(text, "sentense"), issue(text, "mistaek")], []).hints, []);
});
