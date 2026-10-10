// Main flow of the Word add-in's task pane.
//
// 1. Automatic checking (free, runs by itself), following the scrolling. A loop:
//    a. ask Word which pages are on screen and which paragraphs with what text they hold
//    b. ask the bookkeeper (lib/tracker.js) which of them are due: never checked, or
//       edited and the user has paused
//    c. send those paragraphs to the backend's /check in one request (lib/pages.js joins
//       them and converts positions)
//    d. draw lines on them: red for rule issues, lavender for "this sentence could read
//       better" hints (lib/hints.js)
//    e. replace the task pane's list with the issues of the pages on screen
//
// 2. AI rewriting (costs money, runs only after the user clicks). See "AI rewriting" below.
//
// 3. Term lookup, settings, personal dictionary.
//
// Word has no "the user scrolled" event, so it is polled. Measured in real Word: one
// poll takes about 3 ms and reading a screenful of text under 10 ms; users do not notice.
//
// Talking to the backend, settings, personal dictionary, sentence boundaries, hints, diffs
// and cost display all use the same code as the browser extension (its lib/ folder).

import { createApi } from "../browser-extension/lib/api.js";
import { buildIndex, covers, exportText, filterMatches } from "../browser-extension/lib/dictionary.js";
import { addWord, loadDictionary, replaceAll } from "../browser-extension/lib/dictionary-store.js";
import { applyEdits, diffSegments } from "../browser-extension/lib/diff.js";
import { formatCostLine, formatModelLine, formatTotalLine } from "../browser-extension/lib/format.js";
import { fillLanguageSelect, languageName } from "../browser-extension/lib/languages.js";
import { blockedReason, buildScopes } from "../browser-extension/lib/scope.js";
import { sentenceAt, sentenceRanges } from "../browser-extension/lib/sentence.js";
import { loadSettings } from "../browser-extension/lib/settings.js";
import { planEdits } from "./lib/apply.js";
import { layersFor } from "./lib/hints.js";
import { chunkParagraphs, joinParagraphs, locateMatches } from "./lib/pages.js";
import { selectionParts } from "./lib/selection.js";
import { localStore } from "./lib/storage.js";
import { HINT_RULE, Tracker, hintMatch } from "./lib/tracker.js";
import { forWord, isAboutKey } from "./lib/wording.js";

// This page is at .../addin/word-addin/taskpane.html and the API two levels up. A relative
// URL: no domain is hard-coded and the user enters no server address.
const API_URL = new URL("../../", location.href).href.replace(/\/+$/, "");
// How often the screen is polled (ms).
const POLL_MS = 700;
// After a failed request, wait this long before trying again (ms) instead of every 700 ms.
const RETRY_MS = 5000;
// Fixed strings registered in the manifest: the only way to set the popup's titles in Word.
const POPUP_TEXT = { titleResourceId: "Popup.Title", subtitleResourceId: "Popup.Subtitle", brandingTextResourceId: "Popup.Brand" };
// Word's popup shows at most 3 suggestions. The full list is in the task pane.
const MAX_POPUP_SUGGESTIONS = 3;
const MAX_CARD_SUGGESTIONS = 5;
// Names of the issue kinds on cards.
const KIND_LABELS = { misspelling: "Spelling", grammar: "Grammar", typographical: "Punctuation", style: "Style", terminology: "Terminology" };
// The explanation on a hint card. Same as in the browser extension.
const HINT_MESSAGES = {
  issues: "This sentence has several issues. AI can rewrite it in one go.",
  style: "The wording of this sentence could be clearer.",
  long: "This sentence is long. AI may be able to tighten it.",
};

const $ = (id) => document.getElementById(id);
const tracker = new Tracker();
// Settings and personal dictionary are kept on this computer; see lib/storage.js.
const store = localStore(localStorage);
// No server address to enter: this page came from that server.
const api = createApi({
  fetchFn: (...args) => fetch(...args),
  getSettings: async () => ({ ...(await loadSettings(store)), apiUrl: API_URL }),
});

// Personal dictionary: on this computer (separate from the browser extension's; same
// rules). Every check uses it, so a prepared index is kept and dropped when it changes.
let dictionaryIndex = null;
async function knownWords() {
  if (!dictionaryIndex) dictionaryIndex = buildIndex(await loadDictionary(store));
  return dictionaryIndex;
}

// Two settings only the Word add-in has.
let hintLines = true; // draw lavender hint lines in the document? Off: hints are only listed in the task pane
let followCursor = false; // follow the cursor instead of the scrolling; the only option in an older Word
let canWatchPages = true; // whether this Word can report the pages on screen

let paused = false;
let retryAt = 0; // after a failed request: no retry before this time
let visible = { pages: [], ids: [] }; // the pages and paragraphs on screen now
let lastRendered = ""; // what the list looked like when last drawn; unchanged means no redraw
let current = ""; // the entry the user is pointing at or clicked in the document
// A message shown for a few seconds ("that text has changed"), after which the status line returns to normal.
let notice = { text: "", until: 0 };
const NOTICE_MS = 5000;
function flash(text) {
  notice = { text, until: performance.now() + NOTICE_MS };
  render();
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text; // always text, never HTML
  return element;
}

function button(className, text, onClick) {
  const element = el("button", className, text);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

const preview = (text, max = 70) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

// ---------- Rule check: talking to Word ----------

// Send text for a rule check. On failure, throws an error carrying a message for the user.
async function check(text) {
  const reply = await api.check(text);
  if (!reply.ok) throw new Error(forWord(reply.error));
  return reply.data;
}

// The paragraphs to handle now. Returns { pages, paragraphs }; paragraphs are Word
// paragraph objects with text and id loaded.
//   normally: the paragraphs of the pages on screen
//   following the cursor: the paragraph at the cursor (or those a selection touches)
// The objects are used further inside the same Word.run, so the caller supplies context.
async function readVisible(context) {
  if (followCursor) {
    const paragraphs = context.document.getSelection().paragraphs;
    paragraphs.load("text,uniqueLocalId");
    await context.sync();
    return { pages: [], paragraphs: paragraphs.items };
  }
  const pages = context.document.activeWindow.activePane.pagesEnclosingViewport;
  pages.load("index");
  await context.sync();
  const collections = pages.items.map((page) => {
    const paragraphs = page.getRange().paragraphs;
    paragraphs.load("text,uniqueLocalId");
    return paragraphs;
  });
  await context.sync();
  // A paragraph spanning two pages is reported by both: de-duplicate by paragraph id.
  const seen = new Set();
  const paragraphs = [];
  for (const collection of collections) {
    for (const paragraph of collection.items) {
      if (seen.has(paragraph.uniqueLocalId)) continue;
      seen.add(paragraph.uniqueLocalId);
      paragraphs.push(paragraph);
    }
  }
  return { pages: pages.items.map((page) => page.index), paragraphs };
}

// How a rule issue is drawn. One without suggestions gets no popup; its explanation is in the task pane.
function critiqueFor(item) {
  const critique = { colorScheme: Word.CritiqueColorScheme.red, start: item.start, length: item.length };
  const suggestions = (item.match.replacements ?? []).filter(Boolean).slice(0, MAX_POPUP_SUGGESTIONS);
  if (suggestions.length > 0) critique.popupOptions = { ...POPUP_TEXT, suggestions };
  return critique;
}

// Draw check results in the document.
//   results  each { id, text, issues, hints }: paragraph, checked text version, issues, hints
// The paragraphs on screen are read again first: while the backend answered, the user may
// have typed or scrolled. Paragraphs whose text changed are skipped (re-checked next
// round), as are those no longer on screen (checked when scrolled back).
async function draw(results) {
  await Word.run(async (context) => {
    const { paragraphs } = await readVisible(context);
    const onScreen = new Map(paragraphs.map((paragraph) => [paragraph.uniqueLocalId, paragraph]));
    const targets = results.map((result) => ({ ...result, paragraph: onScreen.get(result.id) })).filter((target) => target.paragraph && target.paragraph.text === target.text);
    if (targets.length === 0) return;

    // Delete our earlier lines on these paragraphs first, so no word gets two.
    const existing = targets.map((target) => {
      const annotations = target.paragraph.getAnnotations();
      annotations.load("id");
      return annotations;
    });
    await context.sync();
    targets.forEach((target, index) => {
      const ours = new Set(tracker.linesOf(target.id));
      for (const annotation of existing[index].items) if (ours.has(annotation.id)) annotation.delete();
    });

    for (const target of targets) {
      // Red lines first, one per issue; then hint lines, which break at red lines into short
      // pieces. Colours cannot be stacked: the red line does not show under a lavender one
      // (tried in real Word).
      const pieces = hintLines ? target.hints.flatMap((hint) => hint.pieces) : [];
      const critiques = [...target.issues.map(critiqueFor), ...pieces.map((piece) => ({ colorScheme: Word.CritiqueColorScheme.lavender, start: piece.start, length: piece.length }))];
      if (critiques.length > 0) target.inserted = target.paragraph.insertAnnotations({ critiques });
    }
    await context.sync();

    // Record which entry each line belongs to. Accept and Ignore later rely on this record.
    for (const target of targets) {
      const ids = target.inserted?.value ?? [];
      const entries = target.issues.map((item, index) => ({ id: ids[index], start: item.start, length: item.length, match: item.match }));
      let next = target.issues.length;
      for (const hint of target.hints) {
        const lineIds = hintLines ? ids.slice(next, next + hint.pieces.length) : [];
        next += lineIds.length;
        entries.push({ id: `hint:${target.id}:${hint.offset}`, start: hint.offset, length: hint.length, match: hintMatch(hint.text, hint.reason), lineIds });
      }
      tracker.record(target.id, target.text, entries);
    }
  });
}

// Delete these lines from the document, one by one; some may be gone already, which is not an error.
async function eraseLines(ids) {
  for (const id of ids) {
    await Word.run(async (context) => {
      context.document.getAnnotationById(id).delete();
      await context.sync();
    }).catch(() => {});
  }
}

// Jump to an entry in the document and select it.
async function jumpTo(entry) {
  try {
    await Word.run(async (context) => {
      if (entry.lineIds.length > 0) context.document.getAnnotationById(entry.lineIds[0]).critiqueAnnotation.range.select();
      else context.document.getParagraphByUniqueLocalId(entry.paragraphId).select();
      await context.sync();
    });
  } catch {
    // The line is gone (just edited). The next round updates the list.
  }
}

// ---------- Rule check: one round (look, check, draw) ----------

async function tick() {
  let snapshot = [];
  await Word.run(async (context) => {
    const { pages, paragraphs } = await readVisible(context);
    snapshot = paragraphs.map((paragraph) => ({ id: paragraph.uniqueLocalId, text: paragraph.text }));
    visible = { pages, ids: snapshot.map((paragraph) => paragraph.id) };
  });

  // Paused only means no checking. The pages on screen are still read and the list still follows the scrolling, from earlier results.
  if (paused) return;
  const now = performance.now();
  const due = now < retryAt ? [] : tracker.observe(snapshot, now);
  if (due.length === 0) return;

  setStatus("Checking...");
  const results = [];
  // Usually one screen is one batch. With very many paragraphs (zoomed far out) there are several.
  for (const chunk of chunkParagraphs(due)) {
    const batch = chunk.map((index) => due[index]);
    const { text, spans } = joinParagraphs(batch);
    const data = await check(text);
    // Drop misspellings of words in the personal dictionary.
    const located = locateMatches(spans, filterMatches(data.matches ?? [], await knownWords()));
    // Sentence boundaries are mapped to paragraphs as well; hints need them.
    const sentences = locateMatches(spans, data.sentences ?? []);
    batch.forEach((paragraph, index) => {
      const issues = located.filter((item) => item.index === index && !tracker.isDismissed(item.match));
      const ranges = sentences.filter((item) => item.index === index).map((item) => ({ offset: item.start, length: item.length }));
      const layers = layersFor(paragraph.text, issues, ranges, (sentence) => tracker.isQuiet(sentence));
      results.push({ id: paragraph.id, text: paragraph.text, issues, hints: layers.hints });
    });
  }
  await draw(results);
}

// ---------- Task pane: the issue list ----------

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `status ${kind}`.trim();
}

// Buttons on a card stop the click, so the card's own "jump there" does not fire too.
const act = (action) => (event) => {
  event.stopPropagation();
  action();
};

function cardShell(entry, className) {
  const item = el("li", `${className}${entry.id === current ? " current" : ""}`);
  item.dataset.id = entry.id;
  item.tabIndex = 0;
  const go = () => jumpTo(entry);
  item.addEventListener("click", go);
  item.addEventListener("keydown", (event) => {
    if (event.target === item && (event.key === "Enter" || event.key === " ")) go();
  });
  return item;
}

// The card of one rule issue.
function issueCard(issue) {
  const item = cardShell(issue, "issue");
  item.append(el("div", "kind", KIND_LABELS[issue.match.issue_type] ?? "Suggestion"));

  const fix = el("div", "fix");
  fix.append(el("span", "old", issue.match.text));
  const suggestions = (issue.match.replacements ?? []).filter(Boolean).slice(0, MAX_CARD_SUGGESTIONS);
  if (suggestions.length > 0) fix.append(el("span", "arrow", "→"));
  // One button per suggestion; a click puts it into the document. Word's popup fits 3, here there can be more.
  for (const suggestion of suggestions) fix.append(button("suggest", suggestion, act(() => applySuggestion(issue, suggestion))));
  item.append(fix);
  if (issue.match.message) item.append(el("div", "message", issue.match.message));

  const actions = el("div", "card-actions");
  actions.append(button("link dismiss", "Dismiss", act(() => dismissEntry(issue))));
  // Add to the personal dictionary. Spelling issues only: grammar and terminology are not solved by "I know this word".
  if (issue.match.issue_type === "misspelling") actions.append(button("link add-word", "Add to dictionary", act(() => addToDictionary(issue))));
  // Ask the AI to rewrite the sentence this issue is in. Text is only sent on the click.
  actions.append(button("link ai-link", "Improve sentence with AI", act(() => improveIssue(issue))));
  item.append(actions);
  return item;
}

// The "could read better" hint card. Only an invitation: up to here no AI was called.
function hintCard(hint) {
  const item = cardShell(hint, "issue hint");
  item.append(el("div", "kind", "Could read better"));
  item.append(el("div", "sentence", `“${preview(hint.match.text, 90)}”`));
  item.append(el("div", "message", HINT_MESSAGES[hint.match.reason] ?? HINT_MESSAGES.issues));
  const actions = el("div", "card-actions");
  actions.append(
    button("link ai-link", "Improve with AI", act(() => improveEntrySentence(hint, { offset: hint.start, length: hint.length }))),
    button("link dismiss", "Dismiss", act(() => dismissEntry(hint))),
  );
  item.append(actions);
  return item;
}

function render() {
  const entries = tracker.visibleIssues(visible.ids);
  const rules = entries.filter((entry) => entry.match.rule_id !== HINT_RULE);
  const pages = visible.pages;
  const where = followCursor ? "At the cursor" : pages.length === 0 ? "" : pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages[0]} to ${pages.at(-1)}`;

  // No redraw when nothing changed. Redrawing every 700 ms would swap a card away under the pointer.
  const flashing = performance.now() < notice.until ? notice.text : "";
  const signature = JSON.stringify([where, current, paused, flashing, entries.map((entry) => [entry.id, entry.match.text])]);
  if (signature === lastRendered) return;
  lastRendered = signature;

  $("where").textContent = where;
  $("issues").replaceChildren(...entries.map((entry) => (entry.match.rule_id === HINT_RULE ? hintCard(entry) : issueCard(entry))));
  $("empty").hidden = entries.length > 0;
  if (paused) {
    setStatus("Paused");
    $("empty").textContent = "Checking is paused. Pages you have not looked at before are not checked until you resume.";
  } else {
    // The count at the top is of rule issues. A hint is not an issue; it only suggests an AI look.
    setStatus(rules.length === 0 ? "No issues on screen" : `${rules.length} ${rules.length === 1 ? "issue" : "issues"} on screen`, rules.length === 0 ? "ok" : "");
    $("empty").textContent = followCursor ? "Nothing to fix in the paragraph at the cursor." : "Nothing to fix on the pages you are looking at.";
  }
  if (flashing) setStatus(flashing, "error");
}

// The user clicked or pointed at a line in the document: light up its card and scroll it into view.
function highlight(lineId) {
  const entry = tracker.entryOfLine(lineId);
  if (!entry || entry.id === current) return;
  current = entry.id;
  render();
  document.querySelector(`.issue[data-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- Buttons on issue cards ----------

// Replace several pieces of text in one paragraph. Word cannot fetch text by position,
// only search a paragraph, so each piece's occurrence number is computed first
// (lib/apply.js), found by search, verified to be the original text, and only then
// replaced. Verified in real Word: with a word occurring several times, the right one is
// replaced.
//   baseOffset  the paragraph position the edits' offsets are relative to
// Returns { applied, skipped }. Throws when, for example, the paragraph is not found.
async function replaceInParagraph(paragraphId, baseOffset, edits) {
  let applied = 0;
  let skipped = 0;
  await Word.run(async (context) => {
    const paragraph = context.document.getParagraphByUniqueLocalId(paragraphId);
    paragraph.load("text");
    await context.sync();
    const plan = planEdits(paragraph.text, baseOffset, edits);
    skipped = plan.skipped;
    // Search everything first, then replace, so earlier replacements cannot affect later searches.
    const found = plan.steps.map((step) => {
      const ranges = paragraph.search(step.original, { matchCase: true });
      ranges.load("text");
      return ranges;
    });
    await context.sync();
    plan.steps.forEach((step, index) => {
      const range = found[index].items[step.occurrence];
      if (!range || range.text !== step.original) {
        skipped++;
        return;
      }
      range.insertText(step.replacement, Word.InsertLocation.replace);
      applied++;
    });
    await context.sync();
  });
  return { applied, skipped };
}

// The user clicked a suggestion on a card: replace the word.
async function applySuggestion(issue, replacement) {
  const original = issue.match.text;
  try {
    const { applied } = await replaceInParagraph(issue.paragraphId, issue.start, [{ offset: 0, length: original.length, original, replacement }]);
    if (applied === 0) {
      // The text at that position is no longer the original (just edited). The next round updates the list.
      flash("That text has changed. The list will catch up in a moment.");
      return;
    }
  } catch (error) {
    flash(`Could not change the document: ${error?.message ?? error}`);
    return;
  }
  // Remove line and record now, without waiting. The text changed, so the paragraph is re-checked next round.
  tracker.forget(issue.id);
  render();
  await eraseLines(issue.lineIds);
}

// Dismiss on a card: this issue is not drawn again, and the same issue elsewhere goes too (until the task pane closes).
async function dismissEntry(entry) {
  const lines = tracker.dismiss(entry.id);
  render();
  await eraseLines(lines);
}

// Add to dictionary: the word is no longer reported as a misspelling. Stored on this computer.
async function addToDictionary(issue) {
  const word = issue.match.text;
  const result = await addWord(store, word);
  if (result.problem) {
    flash(result.problem);
    return;
  }
  dictionaryIndex = null;
  // Remove every drawn spelling line of this word, not only on the pages on screen.
  const same = [...tracker.issues.values()].filter((other) => other.match.issue_type === "misspelling" && covers(word, other.match.text));
  for (const other of same) tracker.forget(other.id);
  render();
  await eraseLines(same.flatMap((other) => other.lineIds));
}

// No more hints for these sentences: the AI looked at them, or the user declined the
// edits. Hint lines already drawn are removed too.
async function quietSentences(sentences) {
  const lines = [];
  for (const sentence of sentences) {
    tracker.quiet(sentence);
    for (const entry of [...tracker.issues.values()]) {
      if (entry.match.rule_id === HINT_RULE && entry.match.text === sentence) lines.push(...tracker.dismiss(entry.id));
    }
  }
  render();
  await eraseLines(lines);
}

// ---------- AI rewriting ----------
//
// Runs only after the user clicks, and sends only what they chose: the sentence at the
// cursor, the selection, or the paragraph at the cursor. Only the rule check above runs by
// itself, for the same reason as in the browser extension: the AI sends text to the
// configured model provider and costs money.
//
// Flow: Improve with AI > list the ranges (nothing sent to the AI yet) > pick one > send >
// the task pane shows the diff, reasons and cost > Accept changes the document.
//
// What to rewrite is a list of parts, each a stretch of one paragraph
// { paragraphId, text, offset, length }. Usually one part; a selection across paragraphs
// gives one per paragraph.

// The same text is paid for once while the task pane is open; asking again reuses the result.
const aiResults = new Map();
// Incremented per AI request; an answer checks it to see whether it is still the one being waited for.
let aiTicket = 0;

// Cursor and selection. Returns { paragraphs, start, selected }:
//   paragraphs  the paragraphs the selection touches [{ id, text }]
//   start       where the range starts in the first paragraph
//   selected    the selected text (empty for a bare cursor)
async function readSelection() {
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    selection.load("text");
    const paragraphs = selection.paragraphs;
    paragraphs.load("text,uniqueLocalId");
    await context.sync();
    const first = paragraphs.items[0];
    // The length of the text from the paragraph start to the selection start is the cursor's position in the paragraph.
    const before = first.getRange("Start").expandTo(selection.getRange("Start"));
    before.load("text");
    await context.sync();
    return {
      paragraphs: paragraphs.items.map((paragraph) => ({ id: paragraph.uniqueLocalId, text: paragraph.text })),
      start: Math.min(before.text.length, first.text.length),
      selected: selection.text,
    };
  });
}

// The sentences of a text, asked from the backend (rule-check results include sentence
// boundaries, free). Falls back to lines when that fails.
async function sentencesOf(text) {
  try {
    return sentenceRanges(text, (await check(text)).sentences);
  } catch {
    return sentenceRanges(text, null);
  }
}

function showAi(...children) {
  $("ai").replaceChildren(...children);
  $("ai").hidden = children.length === 0;
  if (children.length > 0) $("ai").scrollIntoView({ block: "nearest" });
}

function closeAi() {
  aiTicket++; // an answer still on its way must not reopen the card
  showAi();
}

function aiHeader() {
  const head = el("div", "ai-head");
  head.append(el("span", "ai-title", "Improve your text"), button("link", "Close", closeAi));
  return head;
}

// Improve with AI was clicked: read cursor and selection and list the ranges. Nothing is sent to the AI yet.
async function openAiMenu() {
  closeAi();
  let where;
  try {
    where = await readSelection();
  } catch (error) {
    showAi(aiHeader(), el("div", "problem", `Could not read the selection: ${error?.message ?? error}`));
    return;
  }
  const options = [];
  const add = (label, parts, detail, blocked) => {
    const option = button("option", "", () => runAi({ parts }));
    option.disabled = Boolean(blocked);
    option.append(el("span", "label", label), el("span", "detail", blocked || detail));
    options.push(option);
  };

  if (where.paragraphs.length > 1) {
    // The selection spans paragraphs: the selected stretch of each is a part, all sent together.
    const parts = selectionParts(where.paragraphs, where.start, where.selected);
    if (!parts || parts.length === 0) {
      showAi(aiHeader(), el("div", "note", "This selection could not be matched to the paragraphs (it may include a table or a picture). Select plain text, or put the cursor in a sentence."));
      return;
    }
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const first = parts[0];
    // The sentence count is only known once the server has split the text, so only length is checked here. With too many sentences the server refuses and says why.
    add("Improve selection", parts, `${parts.length} paragraphs, starting “${preview(first.text.slice(first.offset, first.offset + first.length), 40)}”`, blockedReason(length, 1));
  } else {
    const { id, text } = where.paragraphs[0];
    if (!text.trim()) {
      showAi(aiHeader(), el("div", "note", "Put the cursor in a sentence first."));
      return;
    }
    const selected = where.selected.replace(/[\r\n]+$/, ""); // selecting a whole paragraph includes its paragraph mark
    const end = Math.min(where.start + selected.length, text.length);
    const scopes = buildScopes(text, await sentencesOf(text), { start: where.start, end });
    const addScope = (label, scope) => {
      if (!scope) return;
      add(label, [{ paragraphId: id, text, offset: scope.offset, length: scope.length }], `“${preview(text.slice(scope.offset, scope.offset + scope.length), 60)}”`, scope.blocked);
    };
    addScope("Improve this sentence", scopes.sentence);
    addScope("Improve selection", scopes.selection);
    // With a single sentence, "this paragraph" equals "this sentence": not listed twice.
    if (scopes.all && scopes.all.sentences > 1) addScope("Improve this paragraph", scopes.all);
  }
  showAi(aiHeader(), ...options, el("div", "note", "Nothing is sent to the AI until you choose."));
}

// Rewrite a sentence in an entry's paragraph. Without range: the sentence the entry is in.
async function improveEntrySentence(entry, range) {
  const text = tracker.checked.get(entry.paragraphId);
  if (typeof text !== "string") return;
  closeAi();
  const sentence = range ?? sentenceAt(await sentencesOf(text), entry.start);
  if (!sentence) return;
  runAi({ parts: [{ paragraphId: entry.paragraphId, text, offset: sentence.offset, length: sentence.length }] });
}

const improveIssue = (issue) => improveEntrySentence(issue, null);

// Send the chosen parts to the AI and show the result.
async function runAi(target) {
  // The parts are joined with blank lines into one text; positions are mapped back afterwards (as for the rule check).
  const { text: sent, spans } = joinParagraphs(target.parts.map((part) => ({ text: part.text.slice(part.offset, part.offset + part.length) })));
  target.spans = spans;
  const ticket = ++aiTicket;

  const earlier = aiResults.get(sent);
  if (earlier) {
    showResult(target, earlier, true);
    return;
  }

  const what = target.parts.length > 1 ? `${target.parts.length} paragraphs, starting “${preview(sent, 50)}”` : `“${preview(sent)}”`;
  showAi(aiHeader(), el("div", "waiting", "Asking AI..."), el("div", "note", `Only this is sent: ${what}`));
  const reply = await api.improve(sent);
  // The money is spent: remember the result even if the user closed the card, so a later click does not pay again.
  if (reply.ok) {
    aiResults.set(sent, reply.data);
    // Sentences the AI found fine get no more hints.
    await quietSentences((reply.data.sentences ?? []).filter((item) => item.status === "unchanged").map((item) => item.text));
  }
  // While waiting, the user may have closed the card or clicked something else.
  if (ticket !== aiTicket) return;

  if (!reply.ok) {
    const message = forWord(reply.error);
    const parts = [aiHeader(), el("div", "problem", message)];
    // No key, or the key was rejected: open the settings so the user can enter it.
    if (isAboutKey(message)) parts.push(button("accept", "Open Settings", () => openSettings(true)));
    showAi(...parts);
    return;
  }
  showResult(target, reply.data, false);
}

function showResult(target, data, fromEarlier) {
  const results = data.sentences ?? [];
  if (results.length === 0) {
    showAi(aiHeader(), el("div", "note", "There is nothing to improve here."));
    return;
  }
  const parts = [aiHeader()];
  const changed = [];
  for (const item of results) {
    const section = el("div", "section");
    // Backend positions are relative to the whole text sent; make them relative to this sentence.
    const edits = item.edits.map((edit) => ({ ...edit, offset: edit.offset - item.offset }));
    if (edits.length > 0) changed.push({ before: item.text, after: applyEdits(item.text, edits) });
    const diff = el("div", "diff");
    for (const segment of diffSegments(item.text, edits)) {
      diff.append(segment.type === "same" ? document.createTextNode(segment.text) : el("span", segment.type, segment.text));
    }
    section.append(diff);
    const reasons = [...new Set(item.edits.map((edit) => edit.reason).filter(Boolean))];
    if (reasons.length > 0) {
      const list = el("ul", "reasons");
      for (const reason of reasons) list.append(el("li", "", reason));
      section.append(list);
    }
    if (item.status === "error") section.append(el("div", "problem", item.error || "The AI call failed for this sentence."));
    const cost = formatCostLine(item);
    if (cost) section.append(el("div", "cost", cost));
    parts.push(section);
  }
  const total = formatTotalLine(results);
  if (total) parts.push(el("div", "cost total", total));
  const model = formatModelLine(data.model);
  if (model) parts.push(el("div", "model", model));
  if (fromEarlier) parts.push(el("div", "note", "Checked earlier. Not charged again."));

  const edits = results.flatMap((item) => item.edits);
  const actions = el("div", "actions");
  if (edits.length > 0) {
    actions.append(
      button("accept", "Accept", () => acceptAi(target, edits, changed)),
      // Edits seen and declined mean "leave this sentence": its hint line goes too.
      button("link", "Dismiss", () => {
        closeAi();
        quietSentences(changed.map((item) => item.before));
      }),
    );
  } else {
    actions.append(button("link", "Close", closeAi));
  }
  parts.push(actions);
  showAi(...parts);
}

// Accept was clicked: put the AI's edits into the document (see replaceInParagraph above).
//   edits    the AI's edits, positions relative to the whole text sent
//   changed  each changed sentence before and after
async function acceptAi(target, edits, changed) {
  // Find the part each edit belongs to, convert to a position in that paragraph, group by paragraph.
  const byParagraph = new Map();
  let skipped = 0;
  const located = locateMatches(target.spans, edits);
  skipped += edits.length - located.length; // those between two parts, which cannot be mapped
  for (const item of located) {
    const part = target.parts[item.index];
    const list = byParagraph.get(part.paragraphId) ?? [];
    list.push({ ...item.match, offset: part.offset + item.start });
    byParagraph.set(part.paragraphId, list);
  }

  let applied = 0;
  try {
    for (const [paragraphId, list] of byParagraph) {
      const result = await replaceInParagraph(paragraphId, 0, list);
      applied += result.applied;
      skipped += result.skipped;
    }
  } catch (error) {
    showAi(aiHeader(), el("div", "problem", `Could not change the document: ${error?.message ?? error}`));
    return;
  }
  // The text changed; the loop above notices and re-checks those paragraphs. The resulting
  // sentences were written by the AI and get no "could read better" hint.
  await quietSentences(changed.flatMap((item) => [item.before, item.after]));
  const done = `${applied} ${applied === 1 ? "change" : "changes"} applied.`;
  const trouble = skipped > 0 ? ` ${skipped} could not be applied because the text there has changed.` : "";
  showAi(aiHeader(), el("div", skipped > 0 ? "problem" : "note", done + trouble));
}

// ---------- Term lookup ----------
//
// Chinese or English in; the backend's team glossary is asked, in both directions. No AI.
// The glossary is private to the team, so the key is sent.

let lookupTimer = 0;
let lookupNumber = 0; // lookups sent, to drop stale replies

// Put text on the clipboard. True on success.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The modern clipboard API may be blocked in Word's task pane. The old way: an invisible textarea, select, run the copy command.
    const area = el("textarea");
    area.value = text;
    area.style.cssText = "position: fixed; left: -9999px; top: 0; opacity: 0;";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// Insert a term at the cursor in the document (replacing a selection).
async function insertAtCursor(text) {
  try {
    await Word.run(async (context) => {
      context.document.getSelection().insertText(text, Word.InsertLocation.replace);
      await context.sync();
    });
    return true;
  } catch {
    return false;
  }
}

function showLookup(...children) {
  $("lookup").replaceChildren(...children);
  $("lookup").hidden = children.length === 0;
}

async function runLookup() {
  const query = $("term").value.trim();
  const mine = ++lookupNumber;
  if (!query) {
    showLookup();
    return;
  }
  const reply = await api.lookup(query);
  if (mine !== lookupNumber) return; // the user typed on
  if (!reply.ok) {
    const message = forWord(reply.error);
    const parts = [el("div", "problem", message)];
    if (isAboutKey(message)) parts.push(button("accept", "Open Settings", () => openSettings(true)));
    showLookup(...parts);
    return;
  }
  const rows = reply.data.results ?? [];
  const status = el("div", "note", rows.length === 0 ? "No term like this in the glossary." : "Click a term to copy it.");
  const say = (text) => (status.textContent = text);
  const copyButton = (text, className) =>
    button(`copy ${className}`, text, async () => say((await copyText(text)) ? `Copied: ${text}` : "Could not copy. Select the text and copy it yourself."));
  const items = rows.map((row) => {
    const item = el("div", "term-row");
    item.append(copyButton(row.en, "en"));
    if (row.zh) item.append(copyButton(row.zh, "zh"));
    // What a writer mostly wants is the English term in the document, hence a direct Insert button.
    item.append(button("link insert", "Insert", async () => say((await insertAtCursor(row.en)) ? `Inserted: ${row.en}` : "Could not insert the term.")));
    // One Chinese term with several English terms: applies-to tells them apart.
    if (row.applies_to) item.append(el("div", "applies", `Applies to: ${row.applies_to}`));
    if ((row.variants ?? []).length > 0) {
      const wrong = el("div", "wrong", "Do not use: ");
      row.variants.forEach((variant, index) => wrong.append(index > 0 ? ", " : "", el("s", "", variant)));
      item.append(wrong);
    }
    if (row.note) item.append(el("div", "applies", row.note));
    return item;
  });
  showLookup(status, ...items);
}

function wireLookup() {
  const soon = (delay) => {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(runLookup, delay);
  };
  $("term").addEventListener("input", (event) => {
    // While an IME is composing (pinyin not yet turned into characters) do not search; wait for compositionend.
    if (!event.isComposing) soon(250);
  });
  $("term").addEventListener("compositionend", () => soon(100));
  $("term").addEventListener("keydown", (event) => {
    if (event.key === "Enter") soon(0);
    if (event.key === "Escape") {
      $("term").value = "";
      soon(0);
    }
  });
}

// ---------- Settings ----------

// The two settings only the Word add-in has, stored with the others.
async function loadOwnSettings() {
  const stored = await store.get(["hintLines", "followCursor"]);
  hintLines = stored.hintLines !== false; // off only when false was stored explicitly
  followCursor = !canWatchPages || stored.followCursor === true;
}

// A setting changed: every checked paragraph is checked and drawn again.
function recheckEverything() {
  tracker.checked.clear();
  lastRendered = "";
}

async function openSettings(focusKey = false) {
  const settings = await loadSettings(store);
  $("api-key").value = settings.apiKey;
  fillLanguageSelect($("language"), settings.language);
  $("use-glossary").checked = settings.useGlossary;
  $("hint-lines").checked = hintLines;
  $("follow-cursor").checked = followCursor;
  // In a Word that is too old only following the cursor works, so the box cannot be unticked.
  $("follow-cursor").disabled = !canWatchPages;
  $("settings-status").textContent = "";
  // The personal dictionary is an editable text box, one word per line.
  $("dict-words").value = exportText(await loadDictionary(store));
  $("dict-status").textContent = "";
  $("settings").hidden = false;
  $("settings").scrollIntoView({ block: "nearest" });
  if (focusKey) $("api-key").focus();
}

function wireSettings() {
  const said = (text) => ($("settings-status").textContent = text);
  $("settings-open").addEventListener("click", () => ($("settings").hidden ? openSettings() : ($("settings").hidden = true)));
  $("settings-close").addEventListener("click", () => ($("settings").hidden = true));
  $("show-key").addEventListener("change", (event) => ($("api-key").type = event.target.checked ? "text" : "password"));
  $("save-key").addEventListener("click", async () => {
    await store.set({ apiKey: $("api-key").value.trim() });
    said("Saved.");
  });
  // The language is saved as soon as it is chosen. Checked paragraphs are checked again in the
  // new language, and earlier AI answers are dropped: they were asked for in the old one.
  $("language").addEventListener("change", async (event) => {
    await store.set({ language: event.target.value });
    aiResults.clear();
    recheckEverything();
    said(`Checking as ${languageName(event.target.value) || event.target.value}.`);
  });
  // All three switches save at once and re-check the paragraphs on screen, so the lines follow immediately.
  $("use-glossary").addEventListener("change", async (event) => {
    await store.set({ useGlossary: event.target.checked });
    recheckEverything();
    said(event.target.checked ? "The team glossary is on." : "The team glossary is off.");
  });
  $("hint-lines").addEventListener("change", async (event) => {
    hintLines = event.target.checked;
    await store.set({ hintLines });
    recheckEverything();
    said(hintLines ? "Purple underlines are on." : "Purple underlines are off. The hints are still listed here.");
  });
  $("follow-cursor").addEventListener("change", async (event) => {
    followCursor = event.target.checked;
    await store.set({ followCursor });
    recheckEverything();
    said(followCursor ? "Following the cursor." : "Following the pages on screen.");
  });
  // Personal dictionary: save the whole text box. Delete a line to remove a word, add a line to add one, paste to import.
  $("dict-save").addEventListener("click", async () => {
    const result = await replaceAll(store, $("dict-words").value);
    dictionaryIndex = null;
    // The dictionary changed: checked paragraphs are re-checked, so removed words are flagged again and added ones lose their lines.
    recheckEverything();
    $("dict-words").value = exportText(await loadDictionary(store)); // show the normalised form (sorted, duplicates removed)
    const trouble = result.skipped.length > 0 ? ` ${result.skipped.length} not saved: ${result.skipped[0].problem}` : "";
    $("dict-status").textContent = `Saved. ${result.count} ${result.count === 1 ? "word" : "words"}.${trouble}`;
  });
}

// ---------- Word events ----------

async function registerEvents() {
  await Word.run(async (context) => {
    const { document: doc } = context;
    doc.onAnnotationClicked.add(async (args) => highlight(args.id));
    doc.onAnnotationHovered.add(async (args) => highlight(args.id));
    // A line is gone: a suggestion was accepted (Word replaced the text itself) or the text
    // was edited. Lines we delete before a redraw also arrive here; they are no longer in the
    // record, so nothing happens.
    doc.onAnnotationRemoved.add(async (args) => {
      for (const id of args.ids) tracker.lineGone(id);
      render();
    });
    doc.onAnnotationPopupAction.add(async (args) => {
      // Accept: Word replaces the text itself; the next round sees the changed paragraph and re-checks it.
      if (args.action === "Accept") return;
      // Ignore: remember it and do not draw it again; the same issue elsewhere goes too. The
      // line may already have been removed by Word; the bookkeeper remembers what recently
      // removed lines were.
      const lines = tracker.dismiss(args.id);
      render();
      await eraseLines(lines);
    });
    await context.sync();
  });
}

// ---------- Start ----------

async function loop() {
  try {
    await tick();
    if (paused || performance.now() >= retryAt) render();
  } catch (error) {
    // Most often the server is unreachable (off the network, VPN down). Try again after a while, not constantly.
    retryAt = performance.now() + RETRY_MS;
    lastRendered = "";
    setStatus(error?.message ? String(error.message) : "Something went wrong.", "error");
  }
  setTimeout(loop, POLL_MS);
}

Office.onReady(async (info) => {
  if (info.host !== Office.HostType.Word) {
    setStatus("This page only works inside Word.", "error");
    return;
  }
  if (!Office.context.requirements.isSetSupported("WordApi", "1.8")) {
    setStatus("This version of Word is too old for langfAIx. It needs a current Microsoft 365 version of Word.", "error");
    return;
  }
  // Reading the pages on screen needs a fairly new Word (version 2502 or later). Older ones fall back to following the paragraph at the cursor.
  canWatchPages = Office.context.requirements.isSetSupported("WordApiDesktop", "1.2");
  await loadOwnSettings();
  try {
    await registerEvents();
  } catch (error) {
    setStatus(`Could not listen to Word: ${error?.message ?? error}`, "error");
    return;
  }

  wireSettings();
  wireLookup();
  $("term").disabled = false;
  $("ai-open").disabled = false;
  $("ai-open").addEventListener("click", openAiMenu);
  $("pause").disabled = false;
  $("pause").addEventListener("click", () => {
    paused = !paused;
    $("pause").textContent = paused ? "Resume" : "Pause";
    lastRendered = "";
    render();
  });
  loop();
});
