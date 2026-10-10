// Tests for which part of each paragraph a selection covers.
// Run with npm test in the word-addin folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { selectionParts } from "../lib/selection.js";

const para = (id, text) => ({ id, text });
// The actual text of each selected part.
const texts = (parts) => parts.map((part) => part.text.slice(part.offset, part.offset + part.length));

test("a selection inside one paragraph", () => {
  const paragraph = para("a", "The first one. The second one is here.");
  const start = paragraph.text.indexOf("The second");
  const parts = selectionParts([paragraph], start, "The second one is here.");
  assert.deepEqual(parts, [{ paragraphId: "a", text: paragraph.text, offset: start, length: 23 }]);
});

test("spaces at both ends of the selection are left out", () => {
  const paragraph = para("a", "One.  Two words.  Three.");
  const parts = selectionParts([paragraph], 4, "  Two words.  ");
  assert.deepEqual(texts(parts), ["Two words."]);
});

test("a selection across three paragraphs: tail of the first, all of the second, head of the third", () => {
  const list = [para("a", "Intro. The end of the first."), para("b", "The whole second paragraph."), para("c", "The start of the third. And more.")];
  const start = list[0].text.indexOf("The end");
  const selected = ["The end of the first.", "The whole second paragraph.", "The start of the third."].join("\r");
  const parts = selectionParts(list, start, selected);
  assert.deepEqual(
    parts.map((part) => part.paragraphId),
    ["a", "b", "c"],
  );
  assert.deepEqual(texts(parts), ["The end of the first.", "The whole second paragraph.", "The start of the third."]);
  assert.equal(parts[0].offset, start);
  assert.equal(parts[1].offset, 0);
});

test("a whole paragraph selected together with its paragraph mark", () => {
  // A triple click selects the whole paragraph, paragraph mark included.
  const paragraph = para("a", "Just this one.");
  assert.deepEqual(texts(selectionParts([paragraph], 0, "Just this one.\r")), ["Just this one."]);
});

test("empty paragraphs inside the selection are skipped", () => {
  const list = [para("a", "First."), para("b", ""), para("c", "Third.")];
  const parts = selectionParts(list, 0, "First.\r\rThird.");
  assert.deepEqual(parts.map((part) => part.paragraphId), ["a", "c"]);
});

test("when the text and the paragraphs do not line up, nothing is guessed", () => {
  const list = [para("a", "First paragraph."), para("b", "Second paragraph.")];
  // The position does not match.
  assert.equal(selectionParts(list, 3, "First paragraph."), null);
  // The selected text holds something the paragraphs do not (e.g. a table cell mark).
  assert.equal(selectionParts(list, 0, "First paragraph.\rSecond\u0007paragraph."), null);
  // More pieces than paragraphs.
  assert.equal(selectionParts([list[0]], 0, "First paragraph.\rSecond paragraph."), null);
});

test("nothing selected gives no parts", () => {
  assert.deepEqual(selectionParts([para("a", "Text.")], 2, ""), []);
});
