// Options page: server address and virtual key, with a connection test. Below, the personal dictionary.

import { exportText, listWords } from "../lib/dictionary.js";
import { DICTIONARY_KEY, addWord, importText, loadDictionary, removeWord } from "../lib/dictionary-store.js";
import { fillLanguageSelect } from "../lib/languages.js";
import { glossaryPageUrl, loadSettings, saveSettings, setUseGlossary, validateApiUrl } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const fields = { apiUrl: $("apiUrl"), apiKey: $("apiKey"), language: $("language") };
const status = $("status");

function showStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

// On load, fill the form with the saved settings and only then unlock it.
async function fillForm() {
  const settings = await loadSettings(chrome.storage.local);
  fields.apiUrl.value = settings.apiUrl;
  fields.apiKey.value = settings.apiKey;
  fillLanguageSelect(fields.language, settings.language);
  $("useGlossary").checked = settings.useGlossary;
  showGlossaryLink(settings.apiUrl);
  $("form").disabled = false;
}

// Link to the glossary admin page. It derives from the server address and is hidden while that is empty.
function showGlossaryLink(apiUrl) {
  const page = glossaryPageUrl(apiUrl);
  $("glossaryLink").hidden = !page;
  if (page) $("glossaryLink").href = page;
}

// Save the form. With a bad address, show the reason and return null.
async function save() {
  const problem = validateApiUrl(fields.apiUrl.value);
  if (problem) {
    showStatus(problem, "error");
    fields.apiUrl.focus();
    return null;
  }
  const saved = await saveSettings(chrome.storage.local, {
    apiUrl: fields.apiUrl.value,
    apiKey: fields.apiKey.value,
    language: fields.language.value,
  });
  fields.apiUrl.value = saved.apiUrl; // show the normalised address (trailing slash removed)
  showGlossaryLink(saved.apiUrl);
  return saved;
}

// The glossary switch saves and applies at once. It bypasses save() above, so a half-typed address or key is not saved along.
$("useGlossary").addEventListener("change", async (event) => {
  await setUseGlossary(chrome.storage.local, event.target.checked);
  showStatus(event.target.checked ? "The team glossary is on." : "The team glossary is off.", "ok");
});

$("save").addEventListener("click", async () => {
  if (await save()) showStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  if (!(await save())) return;
  showStatus("Testing...");

  // Step one: is the server there.
  const health = await chrome.runtime.sendMessage({ type: "health" });
  if (!health.ok) {
    showStatus(health.error, "error");
    return;
  }

  // Step two: send a deliberately wrong sentence to confirm the rule check really works.
  const check = await chrome.runtime.sendMessage({ type: "check", text: "This are a test sentense." });
  if (!check.ok) {
    showStatus(`The server is reachable, but checking failed: ${check.error}`, "error");
    return;
  }
  const count = check.data.matches.length;
  showStatus(`Connected. Grammar check works: found ${count} issue${count === 1 ? "" : "s"} in the test sentence.`, "ok");
});

$("showKey").addEventListener("change", (event) => {
  fields.apiKey.type = event.target.checked ? "text" : "password";
});

// ---------- Personal dictionary ----------
//
// Adding, removing and importing save and apply at once, without Save. The dictionary is
// in chrome.storage.local (lib/dictionary-store.js); the background script notices the
// change and uses it from the next check.

function showDictStatus(text, kind = "") {
  $("dictStatus").textContent = text;
  $("dictStatus").className = `status ${kind}`;
}

// Render the words. Always through textContent, never as HTML.
async function showDictionary() {
  const words = listWords(await loadDictionary(chrome.storage.local));
  $("dictCount").textContent = words.length === 0 ? "No words yet." : `${words.length} ${words.length === 1 ? "word" : "words"}`;
  $("dictExport").disabled = words.length === 0;
  const items = words.map((word) => {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = word;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Remove "${word}"`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", async () => {
      await removeWord(chrome.storage.local, word);
      showDictStatus(`Removed "${word}". It will be marked again if it looks misspelled.`, "ok");
      await showDictionary();
    });
    item.append(label, remove);
    return item;
  });
  $("dictList").replaceChildren(...items);
}

async function addFromBox() {
  const word = $("dictWord").value;
  const result = await addWord(chrome.storage.local, word);
  if (result.problem) {
    showDictStatus(result.problem, "error");
    return;
  }
  showDictStatus(result.added ? `Added "${word.trim()}".` : `"${word.trim()}" is already in the dictionary.`, "ok");
  $("dictWord").value = "";
  await showDictionary();
}

$("dictAdd").addEventListener("click", addFromBox);
$("dictWord").addEventListener("keydown", (event) => {
  if (event.key === "Enter") addFromBox();
});

// Export: a text file for the browser to save, one word per line.
$("dictExport").addEventListener("click", async () => {
  const text = exportText(await loadDictionary(chrome.storage.local));
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  link.download = "langfaix-dictionary.txt";
  link.click();
  URL.revokeObjectURL(link.href);
  showDictStatus("Exported to langfaix-dictionary.txt.", "ok");
});

function closeImport() {
  $("dictImportBox").hidden = true;
  $("dictImportText").value = "";
  $("dictImportFile").value = "";
}

$("dictImportOpen").addEventListener("click", () => {
  $("dictImportBox").hidden = false;
  $("dictImportText").focus();
});
$("dictImportCancel").addEventListener("click", closeImport);

// A file was chosen: load it into the text box above, so the user sees what will be imported before pressing Import.
$("dictImportFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (file) $("dictImportText").value = await file.text();
});

$("dictImportRun").addEventListener("click", async () => {
  const result = await importText(chrome.storage.local, $("dictImportText").value);
  const skipped = result.skipped.length;
  // For words not added, state the first reason (usually the same for all: too long, or the dictionary is full).
  const trouble = skipped > 0 ? ` ${skipped} not imported: ${result.skipped[0].problem}` : "";
  showDictStatus(`Imported ${result.added} new ${result.added === 1 ? "word" : "words"}.${trouble}`, skipped > 0 ? "error" : "ok");
  if (skipped === 0) closeImport();
  await showDictionary();
});

// Add to dictionary was clicked on a card in some page: if this page is open, update the list.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[DICTIONARY_KEY]) showDictionary();
});

fillForm();
showDictionary();
