// Background service worker.
//
// The only part of the extension that talks to the server. Popup, options page and
// content scripts do not send requests themselves; they send it a message and it replies
// with the result.
//
// Messages:
//   { type: "health" }                    is the server there
//   { type: "check", text, language }     rule check: free, automatic. Already filtered by the personal dictionary
//   { type: "dictionary-add", word }      add a word to the personal dictionary
//   { type: "improve", text, language }   AI rewrite: costs money, only sent after the user clicked an AI button
//   { type: "estimate" }                  about what one AI-rewritten sentence costs (from earlier calls, offline)
//   { type: "lookup", query }             look a Chinese or English word up in the team glossary
//   { type: "glossary-state" }            whether the team glossary is on
//   { type: "set-glossary", on }          switch the team glossary
//   { type: "open-options" }              open the options page
// Replies: { ok: true, data: ... } or { ok: false, error: "..." }

import { createApi } from "./lib/api.js";
import { buildIndex, filterMatches } from "./lib/dictionary.js";
import { DICTIONARY_KEY, addWord, loadDictionary } from "./lib/dictionary-store.js";
import { EMPTY_STATS, addToStats, averageUsd } from "./lib/estimate.js";
import { loadSettings, setUseGlossary } from "./lib/settings.js";

const api = createApi({
  fetchFn: (...args) => fetch(...args),
  getSettings: () => loadSettings(chrome.storage.local),
});

// ---------- The record behind "about this much per sentence" ----------
//
// After each successful AI call the real cost goes into chrome.storage.local (two numbers,
// see lib/estimate.js). The hint card shows "about US$0.0003" from it. Kept on this
// computer only; it contains no text.
const STATS_KEY = "aiStats";

async function loadStats() {
  const stored = await chrome.storage.local.get(STATS_KEY);
  return stored[STATS_KEY] ?? EMPTY_STATS;
}

// AI responses arriving together are recorded one at a time. Otherwise both read the old
// numbers and write back, and one update is lost.
let statsQueue = Promise.resolve();

function recordSpending(improveData) {
  statsQueue = statsQueue
    .then(async () => {
      const next = addToStats(await loadStats(), improveData);
      await chrome.storage.local.set({ [STATS_KEY]: next });
    })
    .catch(() => {}); // a failed record only makes the estimate less accurate; it must not hide the AI result
  return statsQueue;
}

// ---------- Personal dictionary ----------
//
// Stored in chrome.storage.local (lib/dictionary-store.js). Every check needs it, so a
// prepared index is kept in memory and dropped whenever the dictionary changes (a word
// added on a card, or an edit on the options page); the next use reads it again. The
// browser may stop and restart this worker at any time, which has the same effect.
let cachedIndex = null;

async function dictionaryIndex() {
  if (!cachedIndex) cachedIndex = buildIndex(await loadDictionary(chrome.storage.local));
  return cachedIndex;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[DICTIONARY_KEY]) cachedIndex = null;
});

async function handle(message) {
  switch (message?.type) {
    case "health":
      return api.health();
    case "check": {
      const result = await api.check(String(message.text ?? ""), message.language);
      // Drop misspellings of words in the personal dictionary. Done here, it covers checks in
      // pages and the popup's Quick check alike.
      if (result.ok) result.data = { ...result.data, matches: filterMatches(result.data.matches ?? [], await dictionaryIndex()) };
      return result;
    }
    case "dictionary-add": {
      const result = await addWord(chrome.storage.local, String(message.word ?? ""));
      return result.problem ? { ok: false, error: result.problem } : { ok: true, data: result };
    }
    case "improve": {
      // AI rewrite. This message only exists after the user clicked an AI button in a page.
      const result = await api.improve(String(message.text ?? ""), message.language);
      if (result.ok) await recordSpending(result.data);
      return result;
    }
    case "lookup":
      return api.lookup(String(message.query ?? ""));
    case "glossary-state": {
      // Whether the team glossary is on; the badge card in pages shows it.
      const settings = await loadSettings(chrome.storage.local);
      return { ok: true, data: { on: settings.useGlossary } };
    }
    case "set-glossary":
      // The switch on the card: the same setting as on the options page.
      await setUseGlossary(chrome.storage.local, Boolean(message.on));
      return { ok: true, data: { on: Boolean(message.on) } };
    case "estimate":
      // Average USD per sentence; null before the first AI call. Offline and free.
      return { ok: true, data: { usd: averageUsd(await loadStats()) } };
    case "open-options":
      // A content script cannot open the options page itself.
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from the extension itself.
  if (sender.id !== chrome.runtime.id) return false;

  handle(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  // Returning true means "I will reply later"; Chrome keeps the message channel open.
  return true;
});

// Open the options page on first install: nothing works without a server address.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
