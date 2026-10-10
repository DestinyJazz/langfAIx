// Tests for the personal dictionary rules, and for storing it in the browser and reading it back.
// Run with npm test in the browser-extension folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_WORDS,
  MAX_WORD_LENGTH,
  addWord,
  buildIndex,
  covers,
  emptyDictionary,
  exportText,
  filterMatches,
  importWords,
  knows,
  listWords,
  readDictionary,
  removeWord,
  replaceWords,
  tidyWord,
  wordProblem,
} from "../lib/dictionary.js";
import * as store from "../lib/dictionary-store.js";

const NOW = new Date("2026-10-08T03:00:00.000Z");

// A dictionary with just these words.
const dictionaryOf = (...words) => words.reduce((dictionary, word) => addWord(dictionary, word, NOW).dictionary, emptyDictionary());
const indexOf = (...words) => buildIndex(dictionaryOf(...words));

// A check result shaped like the server's.
const match = (text, issueType = "misspelling") => ({ offset: 0, length: text.length, text, issue_type: issueType, rule_id: "X" });

// A fake chrome.storage.local (as in settings.test.js).
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
  };
}

// ---------- Whether a word is "in the dictionary" ----------

test("a lower-case word covers every way of capitalizing it", () => {
  assert.equal(covers("zyphor", "zyphor"), true);
  assert.equal(covers("zyphor", "Zyphor"), true);
  assert.equal(covers("zyphor", "ZYPHOR"), true);
  assert.equal(covers("zyphor", "zyphors"), false);
});

test("a word with capitals must match exactly", () => {
  // Someone who added Zyphor probably mistyped when writing zyphor, so it is still reported.
  assert.equal(covers("Zyphor", "Zyphor"), true);
  assert.equal(covers("Zyphor", "zyphor"), false);
  assert.equal(covers("Zyphor", "ZYPHOR"), false);
  assert.equal(covers("WebUI", "Webui"), false);
});

test("the index gives the same answers as checking word by word", () => {
  const index = indexOf("zyphor", "WebUI");
  assert.equal(knows(index, "Zyphor"), true);
  assert.equal(knows(index, "WebUI"), true);
  assert.equal(knows(index, "webui"), false);
  assert.equal(knows(index, "other"), false);
  assert.equal(knows(index, "  zyphor "), true); // surrounding whitespace is ignored
});

// ---------- Filtering check results ----------

test("only spelling issues for known words are removed", () => {
  const matches = [match("Zyphor"), match("sentense"), match("Zyphor", "grammar"), match("Zyphor", "terminology")];
  const kept = filterMatches(matches, indexOf("Zyphor"));
  // The misspelling Zyphor is gone; other misspellings stay; grammar and terminology issues on the same word stay too.
  assert.deepEqual(
    kept.map((item) => `${item.text}:${item.issue_type}`),
    ["sentense:misspelling", "Zyphor:grammar", "Zyphor:terminology"],
  );
});

test("an empty dictionary changes nothing", () => {
  const matches = [match("sentense")];
  assert.equal(filterMatches(matches, buildIndex(emptyDictionary())), matches);
});

// ---------- Adding and removing words ----------

test("words are tidied before they are stored", () => {
  assert.equal(tidyWord("  Zyphor   Cloud \n"), "Zyphor Cloud");
  const { dictionary, added } = addWord(emptyDictionary(), "  Zyphor ", NOW);
  assert.equal(added, true);
  assert.deepEqual(dictionary, { version: 1, entries: [{ word: "Zyphor", addedAt: "2026-10-08T03:00:00.000Z" }] });
});

test("adding the same word twice keeps one copy and is not an error", () => {
  const first = dictionaryOf("Zyphor");
  const second = addWord(first, "Zyphor", NOW);
  assert.equal(second.added, false);
  assert.equal(second.problem, "");
  assert.equal(second.dictionary.entries.length, 1);
  // Different case is a different word: Zyphor and zyphor cover different things.
  assert.equal(addWord(first, "zyphor", NOW).added, true);
});

test("empty and overlong words are refused with a reason", () => {
  assert.equal(wordProblem("   "), "Enter a word.");
  assert.match(wordProblem("x".repeat(MAX_WORD_LENGTH + 1)), /too long/);
  assert.equal(wordProblem("x".repeat(MAX_WORD_LENGTH)), "");
  const result = addWord(emptyDictionary(), "", NOW);
  assert.equal(result.added, false);
  assert.equal(result.dictionary.entries.length, 0);
});

test("a full dictionary says so", () => {
  const full = { version: 1, entries: Array.from({ length: MAX_WORDS }, (_, number) => ({ word: `w${number}`, addedAt: "" })) };
  const result = addWord(full, "onemore", NOW);
  assert.equal(result.added, false);
  assert.match(result.problem, /full/);
  // A word already present does not count as "could not be added".
  assert.equal(addWord(full, "w7", NOW).problem, "");
});

test("removing a word leaves the others", () => {
  const dictionary = removeWord(dictionaryOf("Zyphor", "webui"), " Zyphor ");
  assert.deepEqual(listWords(dictionary), ["webui"]);
  assert.deepEqual(listWords(removeWord(dictionary, "not there")), ["webui"]);
});

test("the list is sorted without regard to case", () => {
  assert.deepEqual(listWords(dictionaryOf("zeta", "Alpha", "beta", "alpha")), ["alpha", "Alpha", "beta", "zeta"]);
});

// ---------- Odd content in storage ----------

test("anything unreadable in storage counts as an empty dictionary", () => {
  for (const stored of [undefined, null, "words", 42, [], {}, { entries: "no" }, { version: 9, entries: null }]) {
    assert.deepEqual(readDictionary(stored), emptyDictionary());
  }
});

test("broken entries are dropped and good ones are kept", () => {
  const stored = { version: 1, entries: [{ word: "Zyphor", addedAt: "t" }, null, { word: "" }, { word: 5 }, { word: "Zyphor" }, { word: "x".repeat(99) }, { word: " webui " }] };
  assert.deepEqual(readDictionary(stored).entries, [
    { word: "Zyphor", addedAt: "t" },
    { word: "5", addedAt: "" },
    { word: "webui", addedAt: "" },
  ]);
});

// ---------- Import and export ----------

test("import takes one word per line and reports what it could not take", () => {
  const text = "﻿Zyphor\r\n\r\n  webui  \nZyphor\n" + "x".repeat(MAX_WORD_LENGTH + 5) + "\nNGX";
  const result = importWords(dictionaryOf("webui"), text, NOW);
  assert.equal(result.added, 2); // Zyphor and NGX. webui was there already; the second Zyphor is a repeat
  assert.deepEqual(listWords(result.dictionary), ["NGX", "webui", "Zyphor"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].problem, /too long/);
  assert.ok(result.skipped[0].word.length < 40); // the reported word is shortened, so no wall of text ends up on the page
});

test("import stops at the limit instead of reporting every remaining line", () => {
  const full = { version: 1, entries: Array.from({ length: MAX_WORDS - 1 }, (_, number) => ({ word: `w${number}`, addedAt: "" })) };
  const result = importWords(full, "a1\nb2\nc3\nd4", NOW);
  assert.equal(result.added, 1);
  assert.equal(result.dictionary.entries.length, MAX_WORDS);
  assert.equal(result.skipped.length, 1);
});

test("export can be imported again", () => {
  const original = dictionaryOf("zeta", "Alpha", "Zyphor Cloud");
  const text = exportText(original);
  assert.equal(text, "Alpha\nzeta\nZyphor Cloud\n");
  assert.deepEqual(listWords(importWords(emptyDictionary(), text, NOW).dictionary), listWords(original));
  assert.equal(exportText(emptyDictionary()), "");
});

// ---------- Storing in the browser ----------

test("a word added through the store is there on the next load", async () => {
  const storage = fakeStorage({ apiKey: "sk-user" });
  assert.deepEqual(await store.addWord(storage, "Zyphor", NOW), { added: true, problem: "" });
  assert.deepEqual(storage.data[store.DICTIONARY_KEY], { version: 1, entries: [{ word: "Zyphor", addedAt: "2026-10-08T03:00:00.000Z" }] });
  assert.equal(storage.data.apiKey, "sk-user"); // other settings are untouched
  assert.deepEqual(listWords(await store.loadDictionary(storage)), ["Zyphor"]);
});

test("a refused word is not stored", async () => {
  const storage = fakeStorage();
  const result = await store.addWord(storage, "  ", NOW);
  assert.equal(result.added, false);
  assert.equal(result.problem, "Enter a word.");
  assert.equal(store.DICTIONARY_KEY in storage.data, false);
});

test("remove and import go through the store too", async () => {
  const storage = fakeStorage();
  assert.deepEqual(await store.importText(storage, "Zyphor\nwebui\n", NOW), { added: 2, skipped: [] });
  await store.removeWord(storage, "Zyphor");
  assert.deepEqual(listWords(await store.loadDictionary(storage)), ["webui"]);
});

test("a damaged stored value does not stop the dictionary from working", async () => {
  const storage = fakeStorage({ [store.DICTIONARY_KEY]: "damaged" });
  assert.deepEqual(listWords(await store.loadDictionary(storage)), []);
  await store.addWord(storage, "Zyphor", NOW);
  assert.deepEqual(listWords(await store.loadDictionary(storage)), ["Zyphor"]);
});

// ---------- Replacing the whole dictionary with a text (the Word add-in's settings) ----------

test("replacing the whole list adds, removes and keeps in one go", () => {
  const earlier = new Date("2026-01-01T00:00:00.000Z");
  const before = addWord(addWord(emptyDictionary(), "Zyphor", earlier).dictionary, "webui", earlier).dictionary;
  // webui is removed, Zyphor kept, NGX added. Empty and repeated lines do not count.
  const result = replaceWords(before, "Zyphor\n\nNGX\nNGX\n", NOW);
  assert.deepEqual(listWords(result.dictionary), ["NGX", "Zyphor"]);
  assert.deepEqual(result.skipped, []);
  const added = Object.fromEntries(result.dictionary.entries.map((entry) => [entry.word, entry.addedAt]));
  // Existing words keep their original timestamp; new ones get the current time.
  assert.equal(added.Zyphor, "2026-01-01T00:00:00.000Z");
  assert.equal(added.NGX, "2026-10-08T03:00:00.000Z");
});

test("replacing the list reports lines it cannot take and can empty the dictionary", () => {
  const result = replaceWords(dictionaryOf("Zyphor"), `ok\n${"x".repeat(MAX_WORD_LENGTH + 1)}`, NOW);
  assert.deepEqual(listWords(result.dictionary), ["ok"]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(listWords(replaceWords(dictionaryOf("Zyphor"), "  \n", NOW).dictionary), []);
});

test("the whole list can be replaced through the store", async () => {
  const storage = fakeStorage();
  await store.addWord(storage, "Zyphor", NOW);
  assert.deepEqual(await store.replaceAll(storage, "webui\nNGX", NOW), { count: 2, skipped: [] });
  assert.deepEqual(listWords(await store.loadDictionary(storage)), ["NGX", "webui"]);
});
