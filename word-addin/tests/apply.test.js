// Tests for working out which occurrence an AI edit replaces, for storing settings and for rewording errors.
// Run with npm test in the word-addin folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHttpError, describeNetworkError } from "../../browser-extension/lib/api.js";
import { loadSettings } from "../../browser-extension/lib/settings.js";
import { MAX_SEARCH_LENGTH, planEdits } from "../lib/apply.js";
import { localStore } from "../lib/storage.js";
import { forWord, isAboutKey } from "../lib/wording.js";

// An edit shaped like the backend's /ai/improve: finds original in sent (the text sent to the AI).
function edit(sent, original, replacement, nth = 1) {
  let offset = -1;
  for (let count = 0; count < nth; count++) offset = sent.indexOf(original, offset + 1);
  assert.notEqual(offset, -1);
  return { offset, length: original.length, original, replacement, reason: "" };
}

// ---------- Which occurrence ----------

test("the right one of several identical words is chosen", () => {
  const text = "the cat and the dog saw the bird";
  const { steps, skipped } = planEdits(text, 0, [edit(text, "the", "a", 2)]);
  assert.equal(skipped, 0);
  assert.deepEqual(steps, [{ original: "the", replacement: "a", occurrence: 1, offset: 12 }]);
});

test("edits come back last to first", () => {
  const text = "This are a test sentense.";
  const { steps } = planEdits(text, 0, [edit(text, "This are", "These are"), edit(text, "sentense", "sentence")]);
  assert.deepEqual(
    steps.map((step) => [step.original, step.occurrence]),
    [
      ["sentense", 0],
      ["This are", 0],
    ],
  );
});

test("positions are relative to the part that was sent, not to the paragraph", () => {
  // Two sentences in the paragraph; only the second was sent. Edit positions are relative to it.
  const paragraph = "It has an eror. Here is another eror to fix.";
  const base = paragraph.indexOf("Here");
  const sent = paragraph.slice(base);
  const { steps } = planEdits(paragraph, base, [edit(sent, "eror", "error")]);
  // eror occurs twice in the paragraph; the second one is to be replaced.
  assert.deepEqual(steps, [{ original: "eror", replacement: "error", occurrence: 1, offset: paragraph.lastIndexOf("eror") }]);
});

test("a deletion is an edit with an empty replacement", () => {
  const text = "It is very very good.";
  const { steps } = planEdits(text, 0, [{ offset: 6, length: 5, original: "very ", replacement: "" }]);
  assert.deepEqual(steps, [{ original: "very ", replacement: "", occurrence: 0, offset: 6 }]);
});

// ---------- What cannot be applied ----------

test("an edit is skipped when the text there has changed since it was sent", () => {
  const sent = "This are a test.";
  const now = "These are a test."; // the user already changed it
  const { steps, skipped } = planEdits(now, 0, [edit(sent, "This are", "These are")]);
  assert.deepEqual(steps, []);
  assert.equal(skipped, 1);
});

test("edits that Word could not search for are skipped, the others still apply", () => {
  const long = "x".repeat(MAX_SEARCH_LENGTH + 1);
  const text = `Use ^p here and ${long} and a sentense.`;
  const { steps, skipped } = planEdits(text, 0, [
    edit(text, "^p", "a paragraph mark"), // ^ is special in Word's search
    edit(text, long, "short"), // too long
    { offset: 0, length: 0, original: "", replacement: "Hello " }, // no original text: nothing to search for
    edit(text, "sentense", "sentence"),
  ]);
  assert.deepEqual(steps.map((step) => step.original), ["sentense"]);
  assert.equal(skipped, 3);
});

test("overlapping edits: the later one wins, the earlier one is skipped", () => {
  const text = "a very very long text";
  const { steps, skipped } = planEdits(text, 0, [
    { offset: 2, length: 9, original: "very very", replacement: "really" },
    { offset: 7, length: 9, original: "very long", replacement: "lengthy" },
  ]);
  assert.deepEqual(steps.map((step) => step.original), ["very long"]);
  assert.equal(skipped, 1);
});

test("a word that only matches when counted with overlaps is skipped", () => {
  // "aa" in "aaa": counted left to right without overlap there is only the one at 0. Word's search cannot find the one at 1.
  const { steps, skipped } = planEdits("aaa", 0, [{ offset: 1, length: 2, original: "aa", replacement: "b" }]);
  assert.deepEqual(steps, []);
  assert.equal(skipped, 1);
});

test("no edits, no steps", () => {
  assert.deepEqual(planEdits("text", 0, []), { steps: [], skipped: 0 });
  assert.deepEqual(planEdits("text", 0, null), { steps: [], skipped: 0 });
});

// ---------- Where settings are stored ----------

// A fake localStorage.
function fakeArea(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}

test("the extension's settings code works on top of the Word storage", async () => {
  const area = fakeArea();
  const store = localStore(area);
  // Nothing stored yet: the defaults.
  assert.deepEqual(await loadSettings(store), { apiUrl: "", apiKey: "", language: "en-US", useGlossary: true });
  await store.set({ apiKey: "sk-user", useGlossary: false });
  const settings = await loadSettings(store);
  assert.equal(settings.apiKey, "sk-user");
  assert.equal(settings.useGlossary, false);
  // Stored names carry a prefix, so they cannot clash with anything else on the page.
  assert.deepEqual([...area.data.keys()].sort(), ["langfaix:apiKey", "langfaix:useGlossary"]);
});

test("a damaged stored value counts as not stored", async () => {
  const store = localStore(fakeArea({ "langfaix:apiKey": "{not json" }));
  assert.deepEqual(await store.get(["apiKey", "language"]), {});
});

// ---------- Rewording errors ----------

test("messages written for the extension are reworded for Word", () => {
  // The left side is what lib/api.js really returns. If its wording changes, this test fails as a reminder to follow.
  const missing = describeHttpError(401, { detail: "missing API key: send your key" });
  const rejected = describeHttpError(401, { detail: "the API key was rejected" });
  const offline = describeNetworkError(new TypeError("Failed to fetch"));
  assert.equal(forWord(missing), "The API key is not set. Enter it under Settings.");
  assert.equal(forWord(rejected), "The API key was rejected. Check it under Settings: it may be mistyped or disabled.");
  assert.equal(forWord(offline), "Cannot reach the server. Check that you are on the company network or VPN.");
  for (const message of [missing, rejected, offline]) assert.ok(!forWord(message).includes("extension"), message);
  // Other messages pass through unchanged.
  assert.equal(forWord("Budget has been exceeded. (HTTP 400)"), "Budget has been exceeded. (HTTP 400)");
  assert.equal(forWord(undefined), "");
});

test("key problems are recognised, so the pane can open Settings", () => {
  assert.equal(isAboutKey("The API key is not set. Enter it under Settings."), true);
  assert.equal(isAboutKey("The API key was rejected. Check it under Settings: it may be mistyped or disabled."), true);
  assert.equal(isAboutKey("Cannot reach the server."), false);
});
