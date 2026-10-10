// Rules of the personal dictionary: whether a word is "in the dictionary", and how words
// are added, removed, imported and exported.
//
// Rules only; no browser storage, so this is testable outside a browser. Storage is in
// lib/dictionary-store.js.
//
// A dictionary looks like
//   { version: 1, entries: [ { word: "Zyphor", addedAt: "2026-10-08T03:00:00.000Z" } ] }
// The version and the timestamps are there for a future sync: merging two sides needs to
// know which entry is newer.
//
// The personal dictionary covers spelling only. Grammar, style and team-glossary issues
// are not its business.

export const VERSION = 1;
// Limits, so a whole document is not imported by mistake.
export const MAX_WORD_LENGTH = 60;
export const MAX_WORDS = 5000;

export function emptyDictionary() {
  return { version: VERSION, entries: [] };
}

// Normalise a word: trim, collapse inner whitespace to one space.
export function tidyWord(word) {
  return String(word ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

// Whether the word may be added. Empty string means yes, otherwise the reason for the user.
export function wordProblem(word) {
  const tidy = tidyWord(word);
  if (!tidy) return "Enter a word.";
  if (tidy.length > MAX_WORD_LENGTH) return `This is too long for one word (the limit is ${MAX_WORD_LENGTH} characters).`;
  return "";
}

// Turn what storage returned into a dictionary. Anything odd (never saved, written by another version) becomes an empty one.
export function readDictionary(stored) {
  const dictionary = emptyDictionary();
  const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
  const seen = new Set();
  for (const entry of entries) {
    const word = tidyWord(entry?.word);
    if (!word || word.length > MAX_WORD_LENGTH || seen.has(word)) continue;
    seen.add(word);
    dictionary.entries.push({ word, addedAt: typeof entry.addedAt === "string" ? entry.addedAt : "" });
  }
  return dictionary;
}

// The words in alphabetical order, case variants together. For the settings page.
export function listWords(dictionary) {
  return dictionary.entries.map((entry) => entry.word).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b));
}

// Whether dictionary entry `entry` covers `text` from the document. Same rule as common spellcheckers:
//   all lower case in the dictionary: any case matches. With zyphor added, Zyphor and ZYPHOR pass
//   with capitals in the dictionary: exact match only. With Zyphor added, zyphor is still
//   reported, because that is probably a real mistake
export function covers(entry, text) {
  if (entry === text) return true;
  return entry === entry.toLowerCase() && entry === String(text).toLowerCase();
}

// Index the dictionary for fast lookups: a result can hold dozens of issues.
export function buildIndex(dictionary) {
  const exact = new Set();
  const anyCase = new Set(); // the all-lower-case words
  for (const { word } of dictionary.entries) {
    exact.add(word);
    if (word === word.toLowerCase()) anyCase.add(word);
  }
  return { exact, anyCase };
}

export function knows(index, text) {
  const word = tidyWord(text);
  return index.exact.has(word) || index.anyCase.has(word.toLowerCase());
}

// Remove misspellings of words that are in the dictionary. Everything else stays.
export function filterMatches(matches, index) {
  if (index.exact.size === 0) return matches;
  return matches.filter((match) => !(match.issue_type === "misspelling" && knows(index, match.text)));
}

// Add a word. Returns { dictionary, added, problem }:
//   added    whether it was really added; false if already present, which is not an error
//   problem  why it could not be added, or an empty string
// now is a parameter so tests get fixed results.
export function addWord(dictionary, word, now = new Date()) {
  const tidy = tidyWord(word);
  const problem = wordProblem(tidy);
  if (problem) return { dictionary, added: false, problem };
  if (dictionary.entries.some((entry) => entry.word === tidy)) return { dictionary, added: false, problem: "" };
  if (dictionary.entries.length >= MAX_WORDS) {
    return { dictionary, added: false, problem: `The dictionary is full (${MAX_WORDS} words). Remove some words first.` };
  }
  const entries = [...dictionary.entries, { word: tidy, addedAt: now.toISOString() }];
  return { dictionary: { version: VERSION, entries }, added: true, problem: "" };
}

export function removeWord(dictionary, word) {
  const tidy = tidyWord(word);
  return { version: VERSION, entries: dictionary.entries.filter((entry) => entry.word !== tidy) };
}

// Import, one word per line. Returns { dictionary, added, skipped }:
//   added    how many were added
//   skipped  those not added, each { word, problem }. Words already present are not listed
export function importWords(dictionary, text, now = new Date()) {
  let current = dictionary;
  let added = 0;
  const skipped = [];
  // Strip a leading BOM (files saved by Notepad often have one).
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    const word = tidyWord(line);
    if (!word) continue;
    const result = addWord(current, word, now);
    if (result.problem) {
      skipped.push({ word: word.length > 30 ? `${word.slice(0, 30)}...` : word, problem: result.problem });
      // Full: nothing after this fits either; no need to report each one.
      if (current.entries.length >= MAX_WORDS) break;
      continue;
    }
    if (result.added) added++;
    current = result.dictionary;
  }
  return { dictionary: current, added, skipped };
}

// Replace the whole dictionary with the words in this text (one per line). In the Word
// add-in the dictionary is an editable text box: deleting a line removes a word, adding a
// line adds one, pasting a block imports. Existing words keep their original timestamp.
// Returns { dictionary, skipped }, skipped as in importWords.
export function replaceWords(dictionary, text, now = new Date()) {
  const result = importWords(emptyDictionary(), text, now);
  const before = new Map(dictionary.entries.map((entry) => [entry.word, entry.addedAt]));
  const entries = result.dictionary.entries.map((entry) => ({ word: entry.word, addedAt: before.get(entry.word) ?? entry.addedAt }));
  return { dictionary: { version: VERSION, entries }, skipped: result.skipped };
}

// Export as plain text, one word per line. Re-importable, and usable in other spellcheckers.
export function exportText(dictionary) {
  const words = listWords(dictionary);
  return words.length > 0 ? `${words.join("\n")}\n` : "";
}
