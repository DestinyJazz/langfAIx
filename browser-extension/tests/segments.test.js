// Tests for cutting text into segments by issue position, and for applying a replacement.

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyReplacement, splitIntoSegments } from "../lib/segments.js";

const match = (offset, length, extra = {}) => ({ offset, length, ...extra });
const texts = (segments) => segments.map((s) => s.text);
const flags = (segments) => segments.map((s) => s.match !== null);

test("text without issues is one plain segment", () => {
  assert.deepEqual(splitIntoSegments("All good.", []), [{ text: "All good.", match: null }]);
});

test("issues are cut out in order", () => {
  //            0123456789...
  const text = "This are a test sentense.";
  const segments = splitIntoSegments(text, [match(16, 8), match(0, 4), match(5, 3)]);

  assert.deepEqual(texts(segments), ["This", " ", "are", " a test ", "sentense", "."]);
  assert.deepEqual(flags(segments), [true, false, true, false, true, false]);
});

test("joining the segments gives back the original text", () => {
  const text = "This are a test sentense.";
  const segments = splitIntoSegments(text, [match(0, 4), match(16, 8)]);
  assert.equal(texts(segments).join(""), text);
});

test("positions after an emoji line up without any conversion", () => {
  // Backend positions are UTF-16 code units, i.e. JavaScript indexes. The emoji is 2 code
  // units, so "This are" starts at 3. These numbers are what LanguageTool really returned.
  const text = "\u{1F600} This are a test sentense.";
  const segments = splitIntoSegments(text, [match(3, 8), match(19, 8)]);

  assert.deepEqual(texts(segments), ["\u{1F600} ", "This are", " a test ", "sentense", "."]);
});

test("an overlapping issue is skipped, the earlier one wins", () => {
  const segments = splitIntoSegments("in conjunction with", [match(0, 19), match(3, 11)]);
  assert.deepEqual(texts(segments), ["in conjunction with"]);
  assert.deepEqual(flags(segments), [true]);
});

test("when two issues start at the same place, the longer one wins", () => {
  const segments = splitIntoSegments("This are fine", [match(0, 4), match(0, 8)]);
  assert.deepEqual(texts(segments), ["This are", " fine"]);
});

test("issues outside the text or with bad numbers are ignored", () => {
  const text = "Short.";
  const segments = splitIntoSegments(text, [match(3, 99), match(-1, 2), match(1.5, 2), match(2, 0)]);
  assert.deepEqual(segments, [{ text, match: null }]);
});

test("the match object is kept on its segment", () => {
  const m = match(0, 4, { rule_id: "THIS_NNS", replacements: ["These"] });
  const [first] = splitIntoSegments("This are", [m]);
  assert.equal(first.match, m);
});

test("applyReplacement swaps exactly the matched part", () => {
  assert.equal(applyReplacement("This are a test.", match(5, 3), "is"), "This is a test.");
  // An empty replacement deletes.
  assert.equal(applyReplacement("the the cat", match(0, 4), ""), "the cat");
});

test("applyReplacement works after an emoji", () => {
  assert.equal(applyReplacement("\u{1F600} This are fine.", match(8, 3), "is"), "\u{1F600} This is fine.");
});

// ---------- With the hint layer ----------

import { splitIntoLayers } from "../lib/segments.js";

const hint = (offset, length) => ({ offset, length, reason: "issues" });
// Segments in a readable form: [ ] for red lines, { } for hint lines, the rest as is.
const picture = (layers) => layers.map((l) => (l.match ? `[${l.text}]` : l.hint ? `{${l.text}}` : l.text)).join("");

test("without hints the result matches splitIntoSegments", () => {
  const text = "This are a test sentense.";
  const layers = splitIntoLayers(text, [match(0, 4), match(16, 8)], []);
  assert.equal(picture(layers), "[This] are a test [sentense].");
  assert.equal(layers.map((l) => l.text).join(""), text);
});

test("the hint line is broken where a red line is", () => {
  // The whole sentence is hinted and two words have red lines: the lavender line breaks at the red ones.
  const text = "This are a test sentense.";
  const layers = splitIntoLayers(text, [match(0, 4), match(16, 8)], [hint(0, 25)]);
  assert.equal(picture(layers), "[This]{ are a test }[sentense].");
});

test("pieces with only spaces or punctuation get no hint line", () => {
  // The space between two red lines and the period after one get no line, to avoid stray purple dots.
  const text = "This are a test sentense.";
  const layers = splitIntoLayers(text, [match(0, 4), match(5, 3), match(16, 8)], [hint(0, 25)]);
  assert.equal(picture(layers), "[This] [are]{ a test }[sentense].");
  assert.equal(layers.map((l) => l.text).join(""), text);
});

test("only the hinted sentence gets the hint line", () => {
  //            0         1         2         3         4
  //            01234567890123456789012345678901234567890123456
  const text = "First one is fine. This are a test sentense.";
  const layers = splitIntoLayers(text, [match(19, 4), match(35, 8)], [hint(19, 25)]);
  assert.equal(picture(layers), "First one is fine. [This]{ are a test }[sentense].");
});

test("a clean hinted sentence is one hint segment", () => {
  const text = "Short one. A long clean sentence that is hinted. Tail.";
  const layers = splitIntoLayers(text, [], [hint(11, 37)]);
  assert.equal(picture(layers), "Short one. {A long clean sentence that is hinted.} Tail.");
});

test("two hinted sentences stay separate", () => {
  const text = "One one one. Two two two.";
  const layers = splitIntoLayers(text, [], [hint(0, 12), hint(13, 12)]);
  assert.equal(picture(layers), "{One one one.} {Two two two.}");
  assert.notEqual(layers[0].hint, layers[2].hint);
});

test("joining all layers always gives back the original text", () => {
  const text = "\u{1F600} This are a test sentense. And more here.";
  const layers = splitIntoLayers(text, [match(3, 8), match(19, 8)], [hint(3, 25)]);
  assert.equal(layers.map((l) => l.text).join(""), text);
});
