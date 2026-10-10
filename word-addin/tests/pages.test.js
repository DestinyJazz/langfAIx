// Tests for joining paragraphs for a check and mapping the results back.
// Run with npm test in the word-addin folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CHARS, SEPARATOR, chunkParagraphs, forChecking, joinParagraphs, locateMatches, oddCharacters } from "../lib/pages.js";

const paragraphs = (...texts) => texts.map((text, number) => ({ id: `p${number}`, text }));
// A check result: finds the nth word in the joined text, with offset and length as the backend gives them.
function matchFor(text, word, nth = 1) {
  let offset = -1;
  for (let count = 0; count < nth; count++) offset = text.indexOf(word, offset + 1);
  assert.notEqual(offset, -1, `"${word}" is not in the text`);
  return { offset, length: word.length, text: word };
}

test("paragraphs are joined with a blank line between them", () => {
  const joined = joinParagraphs(paragraphs("First one.", "Second one."));
  assert.equal(joined.text, `First one.${SEPARATOR}Second one.`);
  assert.deepEqual(joined.spans, [
    { index: 0, start: 0, end: 10 },
    { index: 1, start: 12, end: 23 },
  ]);
});

test("empty paragraphs take no room but keep their numbers", () => {
  // Paragraphs 1 and 3 are empty (common in Word documents). Later paragraphs must keep their own index.
  const joined = joinParagraphs(paragraphs("Title", "", "Body text.", "   ", "The end."));
  assert.equal(joined.text, `Title${SEPARATOR}Body text.${SEPARATOR}The end.`);
  assert.deepEqual(
    joined.spans.map((span) => span.index),
    [0, 2, 4],
  );
});

test("a result is placed in the right paragraph at the right position", () => {
  const list = paragraphs("This are wrong.", "", "A sentense here, and a sentense there.");
  const joined = joinParagraphs(list);
  const located = locateMatches(joined.spans, [matchFor(joined.text, "sentense", 2), matchFor(joined.text, "This are"), matchFor(joined.text, "sentense", 1)]);
  assert.deepEqual(
    located.map((item) => [item.index, item.start, item.length]),
    [
      [0, 0, 8],
      [2, 2, 8],
      [2, 23, 8],
    ],
  );
  // After mapping back, that position really holds that word.
  for (const item of located) {
    assert.equal(list[item.index].text.slice(item.start, item.start + item.length), item.match.text);
  }
});

test("emoji before a mistake do not shift it", () => {
  // An emoji takes two positions in a JavaScript string; the backend counts the same way.
  const list = paragraphs("Great 😀🎉 news.", "But this sentense is wrong.");
  const joined = joinParagraphs(list);
  const [located] = locateMatches(joined.spans, [matchFor(joined.text, "sentense")]);
  assert.equal(located.index, 1);
  assert.equal(list[1].text.slice(located.start, located.start + located.length), "sentense");
});

test("results that do not fit inside one paragraph are dropped", () => {
  const joined = joinParagraphs(paragraphs("First.", "Second."));
  const across = { offset: 3, length: 8 }; // from the middle of the first paragraph into the second
  const inGap = { offset: 6, length: 2 }; // exactly on the blank line between two paragraphs
  const beyond = { offset: 999, length: 3 };
  const empty = { offset: 0, length: 0 };
  assert.deepEqual(locateMatches(joined.spans, [across, inGap, beyond, empty]), []);
});

test("a result that ends exactly at the end of a paragraph is kept", () => {
  const joined = joinParagraphs(paragraphs("Ends with erors", "Next."));
  const [located] = locateMatches(joined.spans, [matchFor(joined.text, "erors")]);
  assert.deepEqual([located.index, located.start, located.length], [0, 10, 5]);
});

test("a soft line break inside a paragraph becomes a newline of the same length", () => {
  const text = "Line one\u000bline two with erors";
  assert.equal(forChecking(text), "Line one\nline two with erors");
  assert.equal(forChecking(text).length, text.length);
  assert.equal(forChecking(null), "");
});

test("invisible characters that Word puts in the text are reported", () => {
  assert.deepEqual(oddCharacters("Plain text\twith a tab\nand lines\u000b."), []);
  // 2 is a footnote reference, 1 a picture, 0xFFFC "an object is here".
  assert.deepEqual(oddCharacters("See note\u0002 and picture\u0001 and ￼."), [1, 2, 0xfffc]);
});

test("many paragraphs are split into batches under the limit", () => {
  const list = paragraphs("a".repeat(40), "b".repeat(40), "", "c".repeat(40), "d".repeat(10));
  // Limit 90: the first two paragraphs with the blank line between are 82; a third would exceed it.
  assert.deepEqual(chunkParagraphs(list, 90), [[0, 1], [3, 4]]);
  // Each batch really joins to no more than the limit.
  for (const chunk of chunkParagraphs(list, 90)) {
    assert.ok(joinParagraphs(chunk.map((index) => list[index])).text.length <= 90);
  }
  assert.deepEqual(chunkParagraphs(list), [[0, 1, 3, 4]]);
  assert.ok(MAX_CHARS < 20000);
});

test("one overlong paragraph gets a batch of its own", () => {
  const list = paragraphs("short", "x".repeat(200), "short again");
  assert.deepEqual(chunkParagraphs(list, 50), [[0], [1], [2]]);
  assert.deepEqual(chunkParagraphs([], 50), []);
});
