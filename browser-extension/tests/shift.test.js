// Tests for moving old check results to their new positions after an edit.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shiftMatches } from "../lib/shift.js";

const match = (offset, length, id = "x") => ({ offset, length, id });

// Helper: after shifting, each issue must still point at the same characters.
function fragments(text, matches) {
  return matches.map((m) => text.slice(m.offset, m.offset + m.length));
}

test("nothing changes when the text is the same", () => {
  const matches = [match(0, 4)];
  assert.equal(shiftMatches("This are", "This are", matches), matches);
});

test("typing at the end keeps earlier issues where they are", () => {
  const oldText = "This are a test";
  const newText = "This are a test sentence";
  const shifted = shiftMatches(oldText, newText, [match(0, 4), match(5, 3)]);

  assert.deepEqual(fragments(newText, shifted), ["This", "are"]);
});

test("typing at the start moves every issue to the right", () => {
  const oldText = "This are a test sentense.";
  const newText = "Well, This are a test sentense.";
  const shifted = shiftMatches(oldText, newText, [match(5, 3), match(16, 8)]);

  assert.deepEqual(fragments(newText, shifted), ["are", "sentense"]);
});

test("deleting text before an issue moves it to the left", () => {
  const oldText = "Oh no, This are a test sentense.";
  const newText = "This are a test sentense.";
  const shifted = shiftMatches(oldText, newText, [match(12, 3), match(23, 8)]);

  assert.deepEqual(fragments(newText, shifted), ["are", "sentense"]);
});

test("an issue that is being edited is dropped", () => {
  // The user changes sentense to sentence: the old verdict on that word is void.
  const oldText = "This are a test sentense.";
  const newText = "This are a test sentence.";
  const shifted = shiftMatches(oldText, newText, [match(0, 4), match(16, 8)]);

  assert.deepEqual(fragments(newText, shifted), ["This"]);
});

test("typing right after a word counts as editing that word", () => {
  // Typing "e" right after "sentens" edits that very word.
  const oldText = "a test sentens";
  const newText = "a test sentense";
  assert.deepEqual(shiftMatches(oldText, newText, [match(7, 7)]), []);
});

test("typing a space and a new word after an issue keeps it", () => {
  const oldText = "a test sentense ";
  const newText = "a test sentense here";
  const shifted = shiftMatches(oldText, newText, [match(7, 8)]);
  assert.deepEqual(fragments(newText, shifted), ["sentense"]);
});

test("editing in the middle keeps both sides", () => {
  const oldText = "Teh quick brown fox jumpd over.";
  const newText = "Teh quick red fox jumpd over.";
  const shifted = shiftMatches(oldText, newText, [match(0, 3), match(20, 5)]);

  assert.deepEqual(fragments(newText, shifted), ["Teh", "jumpd"]);
});

test("replacing the whole text drops everything", () => {
  assert.deepEqual(shiftMatches("This are wrong.", "Completely different", [match(0, 4), match(5, 3)]), []);
});

test("clearing the text drops everything", () => {
  assert.deepEqual(shiftMatches("This are wrong.", "", [match(0, 4)]), []);
});

test("repeated characters around the edit do not confuse it", () => {
  // An "a" inserted inside "aaa": identical characters on both sides must not push the algorithm out of bounds.
  const oldText = "xx aaa yy sentense";
  const newText = "xx aaaa yy sentense";
  const shifted = shiftMatches(oldText, newText, [match(10, 8)]);
  assert.deepEqual(fragments(newText, shifted), ["sentense"]);
});

test("other fields on the match are kept", () => {
  const original = { offset: 10, length: 3, rule_id: "R", replacements: ["is"] };
  const [shifted] = shiftMatches("0123456789are", "__0123456789are", [original]);

  assert.deepEqual(shifted, { offset: 12, length: 3, rule_id: "R", replacements: ["is"] });
  // The original object was not modified.
  assert.equal(original.offset, 10);
});
