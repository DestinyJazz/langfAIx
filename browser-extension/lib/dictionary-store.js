// Where the personal dictionary is stored and how it is read and written. This is the
// only file that knows.
//
// Today it is chrome.storage.local: this browser on this computer only, no account, no
// server needed. Syncing across devices later means replacing this one file; the rules
// (lib/dictionary.js) and the UI stay.
//
// storage is chrome.storage.local, passed in so tests can use a fake (as in lib/settings.js).

import { addWord as add, importWords, readDictionary, removeWord as remove, replaceWords } from "./dictionary.js";

// The key in chrome.storage.local. The background script watches it to notice changes.
export const DICTIONARY_KEY = "personalDictionary";

export async function loadDictionary(storage) {
  const stored = await storage.get([DICTIONARY_KEY]);
  return readDictionary(stored[DICTIONARY_KEY]);
}

async function save(storage, dictionary) {
  await storage.set({ [DICTIONARY_KEY]: dictionary });
}

// Add a word. Returns { added, problem }; see addWord in lib/dictionary.js.
export async function addWord(storage, word, now = new Date()) {
  const result = add(await loadDictionary(storage), word, now);
  if (result.added) await save(storage, result.dictionary);
  return { added: result.added, problem: result.problem };
}

export async function removeWord(storage, word) {
  await save(storage, remove(await loadDictionary(storage), word));
}

// Import text, one word per line. Returns { added, skipped }.
export async function importText(storage, text, now = new Date()) {
  const result = importWords(await loadDictionary(storage), text, now);
  if (result.added > 0) await save(storage, result.dictionary);
  return { added: result.added, skipped: result.skipped };
}

// Replace the whole dictionary with the words in this text (one per line). Returns
// { count, skipped }: how many words there are now, and which lines were not taken.
export async function replaceAll(storage, text, now = new Date()) {
  const result = replaceWords(await loadDictionary(storage), text, now);
  await save(storage, result.dictionary);
  return { count: result.dictionary.entries.length, skipped: result.skipped };
}
