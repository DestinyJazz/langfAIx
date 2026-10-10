// Toolbar popup, with two tabs:
//
//   Glossary      lookup. Chinese or English in, the standard term from the team glossary out
//   Quick check   paste text for a rule check. When underlining misbehaves in a page, this
//                 tells whether the server or the page is at fault
//
// As elsewhere, nothing here contacts the server directly; messages go to the background script.

import { applyReplacement, splitIntoSegments } from "../lib/segments.js";
import { glossaryPageUrl, loadSettings } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

// ---------- Tabs ----------

function showPane(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("current", tab.dataset.pane === name);
  $("pane-lookup").hidden = name !== "lookup";
  $("pane-check").hidden = name !== "check";
  (name === "lookup" ? $("term") : $("text")).focus();
}
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showPane(tab.dataset.pane));

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---------- Lookup ----------

// Pause in typing before a lookup (ms), so not every letter sends a request.
const LOOKUP_DELAY_MS = 250;
// The server returns at most this many rows.
const LOOKUP_LIMIT = 20;

const termBox = $("term");
const results = $("results");
let lookupTimer = 0;
let lookupNumber = 0; // lookups sent, to drop stale replies

function lookupStatus(text, kind = "") {
  $("lookup-status").textContent = text;
  $("lookup-status").className = `status ${kind}`;
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text; // textContent: glossary text is never interpreted as HTML
  return element;
}

// A click-to-copy button. One each for Chinese and English, so both directions are usable.
function copyButton(text, className) {
  const button = el("button", `copy ${className}`, text);
  button.type = "button";
  button.title = "Click to copy";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      lookupStatus("Could not copy. Select the text and copy it yourself.", "error");
      return;
    }
    // Flash the button to confirm the copy.
    button.classList.add("copied");
    lookupStatus(`Copied: ${text}`, "ok");
    setTimeout(() => button.classList.remove("copied"), 900);
  });
  return button;
}

function renderResults(rows) {
  results.replaceChildren();
  for (const row of rows) {
    const item = el("li", "result");
    const pair = el("div", "pair");
    pair.append(copyButton(row.en, "en"));
    if (row.zh) pair.append(copyButton(row.zh, "zh"));
    item.append(pair);

    // Category and applies-to. With several English terms for one Chinese term, applies-to tells them apart.
    if (row.category || row.applies_to) {
      const meta = el("div", "meta");
      if (row.category) meta.append(el("span", "chip", row.category));
      if (row.applies_to) meta.append(el("span", "applies", `Applies to: ${row.applies_to}`));
      item.append(meta);
    }
    if (row.variants.length > 0) {
      const wrong = el("div", "meta wrong", "Do not write:");
      for (const variant of row.variants) wrong.append(el("s", "", variant));
      item.append(wrong);
    }
    if (row.note) item.append(el("div", "meta note", row.note));
    results.append(item);
  }
}

async function runLookup() {
  const query = termBox.value.trim();
  const number = ++lookupNumber;
  if (!query) {
    results.replaceChildren();
    lookupStatus("");
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "lookup", query });
  if (number !== lookupNumber) return; // the user typed on while waiting: this result is stale

  if (!result.ok) {
    results.replaceChildren();
    lookupStatus(result.error, "error");
    return;
  }
  const rows = result.data.results;
  renderResults(rows);
  if (rows.length === 0) lookupStatus("No term like this in the glossary.");
  else if (rows.length >= LOOKUP_LIMIT) lookupStatus(`Showing the first ${LOOKUP_LIMIT}. Type more to narrow it down.`);
  else lookupStatus(`${rows.length} ${rows.length === 1 ? "term" : "terms"}. Click a term to copy it.`);
}

termBox.addEventListener("input", () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(runLookup, LOOKUP_DELAY_MS);
});
termBox.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  clearTimeout(lookupTimer); // Enter: look up now
  runLookup();
});

// Two things from the settings: whether the glossary is off, and where the full glossary page is.
loadSettings(chrome.storage.local).then((settings) => {
  $("glossary-off").hidden = settings.useGlossary;
  const page = glossaryPageUrl(settings.apiUrl);
  if (page) {
    $("openGlossary").href = page;
    $("openGlossary").hidden = false;
  }
});

// ---------- Quick check ----------

const textBox = $("text");
const checkButton = $("check");
const status = $("status");
const preview = $("preview");
const detail = $("detail");

// Most suggestions shown at once. LanguageTool already orders them by likelihood.
const MAX_SUGGESTIONS = 5;

function showStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

async function runCheck() {
  const text = textBox.value;
  if (!text.trim()) {
    showStatus("Type some text first.");
    return;
  }

  checkButton.disabled = true;
  showStatus("Checking...");
  detail.hidden = true;

  const result = await chrome.runtime.sendMessage({ type: "check", text });
  checkButton.disabled = false;

  if (!result.ok) {
    preview.hidden = true;
    showStatus(result.error, "error");
    return;
  }

  const matches = result.data.matches;
  showStatus(
    matches.length === 0 ? "No issues found." : `${matches.length} issue${matches.length === 1 ? "" : "s"} found. Click an underlined word.`,
    matches.length === 0 ? "ok" : "",
  );
  renderPreview(text, matches);
}

// Render the checked text: plain text as is, flagged parts wrapped in a span with a squiggle.
function renderPreview(text, matches) {
  preview.replaceChildren();
  for (const segment of splitIntoSegments(text, matches)) {
    if (!segment.match) {
      preview.append(segment.text);
      continue;
    }
    const span = document.createElement("span");
    span.className = "err";
    span.textContent = segment.text;
    span.addEventListener("click", () => showDetail(span, segment.match));
    preview.append(span);
  }
  preview.hidden = false;
}

// Show the explanation and suggestions of one issue.
function showDetail(span, match) {
  for (const other of preview.querySelectorAll(".err.selected")) other.classList.remove("selected");
  span.classList.add("selected");

  detail.querySelector(".message").textContent = match.message;
  detail.querySelector(".rule").textContent = [match.category, match.rule_id].filter(Boolean).join(" · ");

  const box = detail.querySelector(".suggestions");
  box.replaceChildren();
  if (match.replacements.length === 0) {
    box.append("No suggestion for this one.");
  }
  for (const replacement of match.replacements.slice(0, MAX_SUGGESTIONS)) {
    const button = document.createElement("button");
    // An empty suggestion means "remove this".
    button.textContent = replacement === "" ? "(remove)" : replacement;
    button.addEventListener("click", () => {
      // One-click replace: change the text, then check again. The re-check is required: after
      // an edit every later position is off.
      textBox.value = applyReplacement(textBox.value, match, replacement);
      runCheck();
    });
    box.append(button);
  }
  detail.hidden = false;
}

checkButton.addEventListener("click", runCheck);
textBox.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runCheck();
});

termBox.focus();
