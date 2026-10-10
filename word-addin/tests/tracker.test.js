// Tests for the bookkeeping: which paragraphs are due, what was found, which line belongs to which entry, what was dismissed.
// Run with npm test in the word-addin folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEBOUNCE_MS, HINT_RULE, Tracker, hintMatch, issueKey } from "../lib/tracker.js";

const para = (id, text) => ({ id, text });
const match = (text, rule = "SPELL") => ({ text, rule_id: rule, issue_type: "misspelling", replacements: [] });
// A rule issue: the entry id is the id of its line in the document.
const entry = (id, start, text, rule) => ({ id, start, length: text.length, match: match(text, rule) });
// A sentence hint: the entry id is our own; lineIds are its pieces of line in the document.
const hint = (id, start, sentence, lineIds) => ({ id, start, length: sentence.length, match: hintMatch(sentence, "issues"), lineIds });
const ids = (list) => list.map((item) => item.id);

// ---------- Which paragraphs are due ----------

test("paragraphs seen for the first time are checked at once", () => {
  const tracker = new Tracker();
  const due = tracker.observe([para("a", "First one."), para("b", "Second one.")], 1000);
  assert.deepEqual(ids(due), ["a", "b"]);
});

test("a checked paragraph is not checked again while its text stays the same", () => {
  const tracker = new Tracker();
  tracker.observe([para("a", "Text.")], 0);
  tracker.record("a", "Text.", []);
  assert.deepEqual(tracker.observe([para("a", "Text.")], 5000), []);
  // The same after scrolling away and back.
  assert.deepEqual(tracker.observe([para("b", "Other.")], 6000).length, 1);
  assert.deepEqual(tracker.observe([para("a", "Text.")], 7000), []);
});

test("empty paragraphs are never sent", () => {
  const tracker = new Tracker();
  assert.deepEqual(tracker.observe([para("a", ""), para("b", "   ")], 0), []);
  assert.deepEqual(tracker.observe([para("a", "")], 9000), []);
});

test("while the user is typing, the paragraph waits until they pause", () => {
  const tracker = new Tracker();
  tracker.observe([para("a", "Hello")], 0);
  tracker.record("a", "Hello", []);

  // One more character every 300 ms: still changing, no check.
  assert.deepEqual(tracker.observe([para("a", "Hello w")], 300), []);
  assert.deepEqual(tracker.observe([para("a", "Hello wo")], 600), []);
  assert.deepEqual(tracker.observe([para("a", "Hello wor")], 900), []);
  // Paused, but not long enough yet.
  assert.deepEqual(tracker.observe([para("a", "Hello wor")], 900 + DEBOUNCE_MS - 1), []);
  // Long enough.
  assert.deepEqual(tracker.observe([para("a", "Hello wor")], 900 + DEBOUNCE_MS), [para("a", "Hello wor")]);
});

test("a paragraph that is still waiting to be checked stays due", () => {
  // Due on first sight. If the round fails (server unreachable), it must still be due next round.
  const tracker = new Tracker();
  assert.equal(tracker.observe([para("a", "Text.")], 0).length, 1);
  assert.equal(tracker.observe([para("a", "Text.")], DEBOUNCE_MS).length, 1);
});

test("the text is cleared and typed again", () => {
  const tracker = new Tracker();
  tracker.observe([para("a", "Old text.")], 0);
  tracker.record("a", "Old text.", [entry("x1", 0, "Old")]);
  // Emptied: an empty paragraph is recorded as checked and its old issues are discarded.
  assert.deepEqual(tracker.observe([para("a", "")], 100), []);
  assert.deepEqual(tracker.visibleIssues(["a"]), []);
});

// ---------- Results ----------

test("issues are listed for the paragraphs on screen, in document order", () => {
  const tracker = new Tracker();
  tracker.record("p2", "t", [entry("c", 20, "third"), entry("b", 3, "second")]);
  tracker.record("p1", "t", [entry("a", 5, "first")]);
  tracker.record("p9", "t", [entry("z", 0, "elsewhere")]);
  assert.deepEqual(ids(tracker.visibleIssues(["p1", "p2"])), ["a", "b", "c"]);
  // Another screen.
  assert.deepEqual(ids(tracker.visibleIssues(["p9"])), ["z"]);
  assert.deepEqual(tracker.visibleIssues([]), []);
});

test("checking a paragraph again replaces its earlier results", () => {
  const tracker = new Tracker();
  tracker.record("p1", "old", [entry("a", 0, "one"), entry("b", 5, "two")]);
  assert.deepEqual(tracker.linesOf("p1"), ["a", "b"]);
  tracker.record("p1", "new", [entry("c", 0, "three")]);
  assert.deepEqual(ids(tracker.visibleIssues(["p1"])), ["c"]);
  assert.deepEqual(tracker.linesOf("p1"), ["c"]);
  assert.equal(tracker.issues.has("a"), false);
  assert.equal(tracker.entryOfLine("a"), null);
});

test("a removed underline is forgotten, and says what it was", () => {
  const tracker = new Tracker();
  tracker.record("p1", "t", [entry("a", 0, "one"), entry("b", 5, "two")]);
  const gone = tracker.lineGone("a");
  assert.equal(gone.match.text, "one");
  assert.equal(gone.paragraphId, "p1");
  assert.deepEqual(ids(tracker.visibleIssues(["p1"])), ["b"]);
  assert.deepEqual(tracker.linesOf("p1"), ["b"]);
  // The notice for a line may come twice, or be for someone else's line: neither is an error.
  assert.equal(tracker.lineGone("a"), null);
  assert.equal(tracker.lineGone("never-ours"), null);
});

// ---------- Dismissing ----------

test("an ignored issue stays away, here and elsewhere", () => {
  const tracker = new Tracker();
  tracker.record("p1", "t", [entry("a", 0, "Zyphor"), entry("b", 9, "erors")]);
  tracker.record("p2", "t", [entry("c", 4, "Zyphor")]);

  // Dismiss the first Zyphor: the lines to delete are returned, this one's and those of the same word elsewhere.
  assert.deepEqual(tracker.dismiss("a").sort(), ["a", "c"]);
  assert.deepEqual(ids(tracker.visibleIssues(["p1", "p2"])), ["b"]);
  // This keeps it out on a re-check.
  assert.equal(tracker.isDismissed(match("Zyphor")), true);
  assert.equal(tracker.isDismissed(match("erors")), false);
  // The same word reported by another rule is a different issue.
  assert.equal(tracker.isDismissed(match("Zyphor", "GRAMMAR")), false);
  assert.deepEqual(tracker.dismiss("not-there"), []);
});

test("ignoring works even when Word has already taken the underline away", () => {
  // The order seen in real Word: first "line removed", then "user clicked Ignore".
  const tracker = new Tracker();
  tracker.record("p1", "t", [entry("a", 0, "Zyphor")]);
  tracker.record("p2", "t", [entry("c", 4, "Zyphor"), entry("d", 9, "erors")]);
  tracker.lineGone("a");
  assert.deepEqual(tracker.dismiss("a").sort(), ["a", "c"]);
  assert.equal(tracker.isDismissed(match("Zyphor")), true);
  assert.deepEqual(ids(tracker.visibleIssues(["p1", "p2"])), ["d"]);
});

test("only the most recent removed underlines are remembered", () => {
  const tracker = new Tracker();
  const many = Array.from({ length: 260 }, (_, number) => entry(`id${number}`, number, `w${number}`));
  tracker.record("p1", "t", many);
  for (const item of many) tracker.lineGone(item.id);
  assert.ok(tracker.gone.size <= 200);
  assert.equal(tracker.gone.has("id259"), true);
  assert.equal(tracker.gone.has("id0"), false);
});

test("the key of an issue is its rule and its word", () => {
  assert.equal(issueKey(match("erors")), "SPELL|erors");
  assert.equal(issueKey({}), "|");
});

// ---------- Hints: one entry, several lines ----------

test("a hint owns several pieces of underline, or none", () => {
  const tracker = new Tracker();
  const sentence = "This sentense has a mistaek.";
  tracker.record("p1", sentence, [hint("h1", 0, sentence, ["s1", "s2", "s3"]), entry("r1", 5, "sentense"), entry("r2", 20, "mistaek")]);
  // The lines to delete before a redraw: two red ones and the hint's three pieces.
  assert.deepEqual(tracker.linesOf("p1").sort(), ["r1", "r2", "s1", "s2", "s3"]);
  // The user points at one piece: which sentence's hint is it?
  assert.equal(tracker.entryOfLine("s2").id, "h1");
  assert.equal(tracker.entryOfLine("r1").id, "r1");
  // At the same position a hint sorts before the issues of its sentence.
  assert.deepEqual(ids(tracker.visibleIssues(["p1"])), ["h1", "r1", "r2"]);

  // Hint lines turned off: the hint is still recorded, just without lines.
  tracker.record("p2", sentence, [hint("h2", 0, sentence, [])]);
  assert.deepEqual(tracker.linesOf("p2"), []);
  assert.deepEqual(ids(tracker.visibleIssues(["p2"])), ["h2"]);
});

test("losing one piece of a hint's underline does not lose the hint", () => {
  const tracker = new Tracker();
  tracker.record("p1", "t", [hint("h1", 0, "A long sentence here.", ["s1", "s2"])]);
  assert.equal(tracker.lineGone("s1"), null);
  assert.deepEqual(ids(tracker.visibleIssues(["p1"])), ["h1"]);
  assert.deepEqual(tracker.linesOf("p1"), ["s2"]);
  assert.equal(tracker.entryOfLine("s1"), null);
});

test("a dismissed hint stays away, and its pieces are handed back for erasing", () => {
  const tracker = new Tracker();
  const sentence = "A long sentence here.";
  tracker.record("p1", "t", [hint("h1", 0, sentence, ["s1", "s2"]), entry("r1", 2, "long")]);
  // Dismissed from a card: the entry id is given.
  assert.deepEqual(tracker.dismiss("h1").sort(), ["s1", "s2"]);
  assert.deepEqual(ids(tracker.visibleIssues(["p1"])), ["r1"]);
  assert.equal(tracker.isQuiet(sentence), true);
  assert.equal(tracker.isQuiet("Another sentence."), false);
});

test("a sentence can be made quiet without having been hinted", () => {
  // Sentences the AI found fine, and sentences after accepted AI edits, get no more hints.
  const tracker = new Tracker();
  tracker.quiet("These are fine.");
  assert.equal(tracker.isQuiet("These are fine."), true);
  assert.equal(hintMatch("x", "long").rule_id, HINT_RULE);
});
