// Tests for turning a sentence plus edits into the pieces shown on the card, and for applying edits.

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEdits, diffSegments, lastToFirst } from "../lib/diff.js";

const edit = (offset, length, replacement) => ({ offset, length, replacement });
const show = (segments) => segments.map((s) => (s.type === "same" ? s.text : s.type === "removed" ? `[-${s.text}-]` : `[+${s.text}+]`)).join("");

test("no edits gives the sentence unchanged", () => {
  assert.deepEqual(diffSegments("All good.", []), [{ type: "same", text: "All good." }]);
  assert.deepEqual(diffSegments("All good.", undefined), [{ type: "same", text: "All good." }]);
});

test("one replacement shows the old words struck out and the new ones added", () => {
  //            0         1         2         3         4         5
  //            0123456789012345678901234567890123456789012345678901234567
  const text = "It supports user authentication in conjunction with LDAP.";
  const segments = diffSegments(text, [edit(32, 19, "together with")]);
  assert.equal(show(segments), "It supports user authentication [-in conjunction with-][+together with+] LDAP.");
});

test("several edits are shown in order even if given out of order", () => {
  const text = "This are a test sentense.";
  const segments = diffSegments(text, [edit(16, 8, "sentence"), edit(0, 8, "This is")]);
  assert.equal(show(segments), "[-This are-][+This is+] a test [-sentense-][+sentence+].");
});

test("a deletion has nothing added", () => {
  const segments = diffSegments("the the cat", [edit(0, 4, "")]);
  assert.equal(show(segments), "[-the -]the cat");
});

test("a pure insertion has nothing removed", () => {
  // The AI rarely gives a zero-length edit, but it must not break anything.
  const segments = diffSegments("Click Save then close.", [edit(10, 0, ",")]);
  assert.equal(show(segments), "Click Save[+,+] then close.");
});

test("overlapping or out-of-range edits are ignored", () => {
  const text = "in conjunction with";
  const segments = diffSegments(text, [edit(0, 19, "with"), edit(3, 11, "combination"), edit(50, 3, "x")]);
  assert.equal(show(segments), "[-in conjunction with-][+with+]");
});

test("joining the same and removed parts gives back the original", () => {
  const text = "This are a test sentense.";
  const segments = diffSegments(text, [edit(0, 8, "This is"), edit(16, 8, "sentence")]);
  const original = segments.filter((s) => s.type !== "added").map((s) => s.text).join("");
  assert.equal(original, text);
});

test("applyEdits produces the corrected sentence", () => {
  assert.equal(applyEdits("This are a test sentense.", [edit(16, 8, "sentence"), edit(0, 8, "This is")]), "This is a test sentence.");
  assert.equal(applyEdits("the the cat", [edit(0, 4, "")]), "the cat");
  assert.equal(applyEdits("No change.", []), "No change.");
});

test("joining the same and added parts equals applyEdits", () => {
  const text = "It supports user authentication in conjunction with LDAP.";
  const edits = [edit(32, 19, "together with")];
  const fromSegments = diffSegments(text, edits).filter((s) => s.type !== "removed").map((s) => s.text).join("");
  assert.equal(fromSegments, applyEdits(text, edits));
});

test("lastToFirst orders edits from the end of the sentence", () => {
  const edits = [edit(0, 8, "This is"), edit(16, 8, "sentence")];
  assert.deepEqual(lastToFirst("This are a test sentense.", edits).map((e) => e.offset), [16, 0]);
});
