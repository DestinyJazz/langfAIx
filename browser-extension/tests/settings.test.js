// Tests for loading and saving settings and for validating the address.
// Run with npm test in the browser-extension folder.

import assert from "node:assert/strict";
import { test } from "node:test";

import { glossaryPageUrl, loadSettings, normalizeApiUrl, saveSettings, setUseGlossary, validateApiUrl } from "../lib/settings.js";

// A fake chrome.storage.local: a plain object that remembers what was stored.
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

test("normalizeApiUrl removes spaces and trailing slashes", () => {
  assert.equal(normalizeApiUrl("  https://example.com/api/  "), "https://example.com/api");
  assert.equal(normalizeApiUrl("https://example.com/api///"), "https://example.com/api");
  assert.equal(normalizeApiUrl(undefined), "");
});

test("validateApiUrl accepts a normal address", () => {
  assert.equal(validateApiUrl("https://example.com/api"), "");
  assert.equal(validateApiUrl("http://192.168.1.5:8000/api/"), "");
});

test("validateApiUrl explains what is wrong", () => {
  assert.match(validateApiUrl(""), /Enter the server address/);
  assert.match(validateApiUrl("example.com/api"), /not a valid address/);
  assert.match(validateApiUrl("ftp://example.com"), /must start with https/);
});

test("loadSettings returns defaults when nothing is stored", async () => {
  const settings = await loadSettings(fakeStorage());
  assert.deepEqual(settings, { apiUrl: "", apiKey: "", language: "en-US", useGlossary: true });
});

test("saveSettings cleans the values and loadSettings reads them back", async () => {
  const storage = fakeStorage();
  await saveSettings(storage, { apiUrl: " https://example.com/api/ ", apiKey: "  sk-abc  ", language: "en-GB" });

  assert.deepEqual(await loadSettings(storage), {
    apiUrl: "https://example.com/api",
    apiKey: "sk-abc",
    language: "en-GB",
    useGlossary: true,
  });
});

test("saveSettings falls back to en-US when the language is empty", async () => {
  const saved = await saveSettings(fakeStorage(), { apiUrl: "https://example.com/api", apiKey: "", language: "" });
  assert.equal(saved.language, "en-US");
});

// ---------- The team glossary switch ----------

test("the glossary switch is on by default and remembers being turned off", async () => {
  const storage = fakeStorage();
  assert.equal((await loadSettings(storage)).useGlossary, true);

  await setUseGlossary(storage, false);
  assert.equal((await loadSettings(storage)).useGlossary, false);

  await setUseGlossary(storage, true);
  assert.equal((await loadSettings(storage)).useGlossary, true);
});

test("saving the address and key does not flip the glossary switch", async () => {
  const storage = fakeStorage();
  await setUseGlossary(storage, false);
  await saveSettings(storage, { apiUrl: "https://example.com/api", apiKey: "sk-abc", language: "en-US" });
  assert.equal((await loadSettings(storage)).useGlossary, false);
});

test("turning the switch does not touch the address or the key", async () => {
  const storage = fakeStorage({ apiUrl: "https://example.com/api", apiKey: "sk-abc", language: "en-GB" });
  await setUseGlossary(storage, false);
  const settings = await loadSettings(storage);
  assert.deepEqual([settings.apiUrl, settings.apiKey, settings.language], ["https://example.com/api", "sk-abc", "en-GB"]);
});

test("a strange stored value counts as switched on", async () => {
  // Off only when false was stored explicitly.
  assert.equal((await loadSettings(fakeStorage({ useGlossary: "no" }))).useGlossary, true);
  assert.equal((await loadSettings(fakeStorage({ useGlossary: null }))).useGlossary, true);
});

test("the glossary page lives next to the API", () => {
  assert.equal(glossaryPageUrl("https://example.com/api"), "https://example.com/api/admin/");
  assert.equal(glossaryPageUrl(" https://example.com/api/ "), "https://example.com/api/admin/");
  assert.equal(glossaryPageUrl(""), ""); // no server address yet: no link to give
});
