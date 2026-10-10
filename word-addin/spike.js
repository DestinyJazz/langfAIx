// Diagnostics: test in real Word the things that cannot be tested anywhere else. Not a
// product feature.
//
// Each button answers one question and writes what it did and what came back to the log.
// The design of the automatic checking was based on these results, and the log is what to
// attach when something misbehaves in Word.
//
// The Word API calls follow Microsoft's official samples (manage-annotations and get-pages
// in office-js-snippets).

import { chunkParagraphs, joinParagraphs, locateMatches, oddCharacters } from "./lib/pages.js";

// This page is at .../addin/word-addin/spike.html and the API two levels up. A relative
// URL works under /api and on a dev machine alike, with no domain hard-coded.
const API = new URL("../../", location.href);
// How often the pages on screen are polled (ms).
const POLL_MS = 700;
// Fixed strings registered in the manifest: the only way to set the popup's titles in Word.
const POPUP_TEXT = { titleResourceId: "Popup.Title", subtitleResourceId: "Popup.Subtitle", brandingTextResourceId: "Popup.Brand" };
// Word's popup shows at most 3 suggestions.
const MAX_SUGGESTIONS = 3;

const $ = (id) => document.getElementById(id);

// ---------- Log ----------

const started = performance.now();

function log(line = "") {
  const seconds = ((performance.now() - started) / 1000).toFixed(1).padStart(6);
  const box = $("log");
  box.value += `${seconds}s  ${line}\n`;
  box.scrollTop = box.scrollHeight;
}

// One line per error. Word API errors carry code and debugInfo, far more useful than the message alone.
function describe(error) {
  const parts = [error?.name, error?.code, error?.message].filter(Boolean);
  const where = error?.debugInfo?.errorLocation;
  if (where) parts.push(`at ${where}`);
  return parts.join(" | ") || String(error);
}

// Run a button's action. An error does not break the page; it goes into the log.
async function run(title, action) {
  log(`=== ${title} ===`);
  const from = performance.now();
  try {
    await action();
  } catch (error) {
    log(`ERROR: ${describe(error)}`);
  }
  log(`(${title}: ${Math.round(performance.now() - from)} ms)`);
  log();
}

const preview = (text, max = 60) => {
  const flat = String(text ?? "").replace(/\s+/g, " ");
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}...` : flat);
};

// ---------- Asking the backend for check results ----------

async function check(text) {
  const response = await fetch(new URL("check", API), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: "en-US" }),
  });
  if (!response.ok) throw new Error(`the server answered HTTP ${response.status} to /check`);
  return (await response.json()).matches ?? [];
}

// How an issue is drawn.
function critiqueFor(start, length, replacements, colorScheme = Word.CritiqueColorScheme.red, withPopup = true) {
  const critique = { colorScheme, start, length };
  if (withPopup) critique.popupOptions = { ...POPUP_TEXT, suggestions: replacements.slice(0, MAX_SUGGESTIONS) };
  return critique;
}

// Ids of the lines we drew, so Clear can delete them.
const drawn = new Set();

// Draw lines on a paragraph. First with a popup; if Word refuses (e.g. it does not know the
// manifest strings), again without. Returns { ids, withPopup }.
async function insert(context, paragraph, critiques) {
  try {
    const ids = paragraph.insertAnnotations({ critiques });
    await context.sync();
    for (const id of ids.value) drawn.add(id);
    return { ids: ids.value, withPopup: true };
  } catch (error) {
    log(`  inserting with a popup failed (${describe(error)}), trying without`);
    const plain = critiques.map(({ popupOptions, ...rest }) => rest);
    const ids = paragraph.insertAnnotations({ critiques: plain });
    await context.sync();
    for (const id of ids.value) drawn.add(id);
    return { ids: ids.value, withPopup: false };
  }
}

// Ask Word which characters each line on this paragraph really covers. The key step of
// the whole test: no eyeballing, just compare the intended text with what Word underlined.
async function readBack(context, paragraph) {
  const annotations = paragraph.getAnnotations();
  annotations.load("id,state");
  await context.sync();
  const ranges = annotations.items.map((annotation) => {
    const range = annotation.critiqueAnnotation.range;
    range.load("text");
    return { id: annotation.id, state: annotation.state, range };
  });
  await context.sync();
  return ranges.map((item) => ({ id: item.id, state: item.state, text: item.range.text }));
}

// Delete existing lines on the paragraph, so no word is underlined twice.
async function removeAnnotations(context, paragraph) {
  const annotations = paragraph.getAnnotations();
  annotations.load("id");
  await context.sync();
  for (const annotation of annotations.items) {
    drawn.delete(annotation.id);
    annotation.delete();
  }
  await context.sync();
  return annotations.items.length;
}

// ---------- 1. Environment ----------

async function environment() {
  log(`address of this page: ${location.origin}${location.pathname}`);
  log(`host: ${Office.context.host}, platform: ${Office.context.platform}`);
  log(`diagnostics: ${JSON.stringify(Office.context.diagnostics ?? null)}`);
  log(`browser inside Word: ${navigator.userAgent}`);

  const supported = (name, version) => Office.context.requirements.isSetSupported(name, version);
  log(`WordApi: ${["1.5", "1.6", "1.7", "1.8", "1.9"].map((v) => `${v} ${supported("WordApi", v) ? "yes" : "NO"}`).join(", ")}`);
  log(`WordApiDesktop: ${["1.1", "1.2", "1.3", "1.4"].map((v) => `${v} ${supported("WordApiDesktop", v) ? "yes" : "NO"}`).join(", ")}`);
  log("  needed: WordApi 1.8 for underlines with a popup, WordApiDesktop 1.2 to know which pages are on screen");

  try {
    const response = await fetch(new URL("healthz", API));
    log(`server: HTTP ${response.status} ${JSON.stringify(await response.json())}`);
  } catch (error) {
    log(`server: CANNOT BE REACHED (${describe(error)})`);
  }

  // Settings and the personal dictionary are stored here. Does it work, and does it survive restarting Word?
  try {
    const key = "langfaix-spike-last-opened";
    log(`localStorage: works. Value left by the previous run: ${localStorage.getItem(key) ?? "(nothing, this is the first run)"}`);
    localStorage.setItem(key, new Date().toISOString());
  } catch (error) {
    log(`localStorage: NOT AVAILABLE (${describe(error)})`);
  }
}

// ---------- 2. One paragraph ----------

async function checkParagraph() {
  await Word.run(async (context) => {
    const paragraph = context.document.getSelection().paragraphs.getFirst();
    paragraph.load("text,uniqueLocalId,isListItem,tableNestingLevel");
    await context.sync();

    const text = paragraph.text;
    log(`paragraph ${paragraph.uniqueLocalId}: ${text.length} characters, list item: ${paragraph.isListItem}, table level: ${paragraph.tableNestingLevel}`);
    log(`  text: ${preview(text, 120)}`);
    const odd = oddCharacters(text);
    if (odd.length > 0) log(`  invisible characters in the text (codes): ${odd.join(", ")}`);

    const removed = await removeAnnotations(context, paragraph);
    if (removed > 0) log(`  removed ${removed} underline(s) that were already there`);

    const { text: joined, spans } = joinParagraphs([{ text }]);
    if (!joined) {
      log("  the paragraph is empty, nothing to check");
      return;
    }
    const located = locateMatches(spans, await check(joined));
    log(`  the server found ${located.length} issue(s)`);
    if (located.length === 0) return;

    const result = await insert(
      context,
      paragraph,
      located.map((item) => critiqueFor(item.start, item.length, item.match.replacements ?? [])),
    );
    log(`  inserted ${result.ids.length} underline(s), ${result.withPopup ? "with" : "WITHOUT"} a popup`);

    // Verify which characters Word really underlined.
    const actual = await readBack(context, paragraph);
    let wrong = 0;
    located.forEach((item, index) => {
      const wanted = text.slice(item.start, item.start + item.length);
      const got = actual.find((entry) => entry.id === result.ids[index])?.text;
      const ok = got === wanted;
      if (!ok) wrong++;
      log(`  ${ok ? "ok   " : "WRONG"} [${item.start}, +${item.length}] wanted ${preview(wanted)}, Word underlined ${preview(got)} -> ${JSON.stringify((item.match.replacements ?? []).slice(0, MAX_SUGGESTIONS))}`);
    });
    log(wrong === 0 ? "  POSITIONS: all correct" : `  POSITIONS: ${wrong} of ${located.length} are WRONG`);
  });
}

// ---------- Popup and events ----------

// One log line per event. Hover events come in bursts: only the first of a run on the same line is logged.
let lastHovered = "";

async function describeAnnotation(id) {
  let text = "(could not be read)";
  let state = "?";
  await Word.run(async (context) => {
    const annotation = context.document.getAnnotationById(id);
    annotation.load("state");
    const range = annotation.critiqueAnnotation.range;
    range.load("text");
    await context.sync();
    text = range.text;
    state = annotation.state;
  }).catch((error) => {
    text = `(${describe(error)})`;
  });
  return `${id.slice(0, 8)} state ${state} text ${preview(text)}`;
}

async function onPopupAction(args) {
  log(`EVENT popup action: ${args.action}, suggestion ${JSON.stringify(args.critiqueSuggestion ?? null)}, underline ${await describeAnnotation(args.id)}`);
  if (args.action !== "Accept" || !$("replace-myself").checked) return;
  // The add-in replaces the text: take the range under the line and insert the chosen suggestion.
  try {
    await Word.run(async (context) => {
      const annotation = context.document.getAnnotationById(args.id);
      const range = annotation.critiqueAnnotation.range;
      range.insertText(args.critiqueSuggestion, Word.InsertLocation.replace);
      await context.sync();
    });
    log("  the add-in replaced the text");
  } catch (error) {
    log(`  the add-in could NOT replace the text: ${describe(error)}`);
  }
}

async function registerEvents() {
  await Word.run(async (context) => {
    const { document } = context;
    document.onAnnotationClicked.add(async (args) => log(`EVENT clicked: ${await describeAnnotation(args.id)}`));
    document.onAnnotationHovered.add(async (args) => {
      if (args.id === lastHovered) return;
      lastHovered = args.id;
      log(`EVENT hovered: ${await describeAnnotation(args.id)}`);
    });
    document.onAnnotationInserted.add(async (args) => log(`EVENT inserted: ${args.ids.length} underline(s)`));
    document.onAnnotationRemoved.add(async (args) => log(`EVENT removed: ${args.ids.length} underline(s)`));
    document.onAnnotationPopupAction.add(onPopupAction);
    // The paragraph-changed event, which tells which paragraph needs a re-check.
    document.onParagraphChanged.add(async (args) => log(`EVENT paragraph changed: ${args.uniqueLocalIds.length} paragraph(s), type ${args.type}`));
    await context.sync();
  });
  log("event handlers registered: clicked, hovered, inserted, removed, popup action, paragraph changed");
}

// ---------- 3. Two colours ----------

async function twoColours() {
  await Word.run(async (context) => {
    const paragraph = context.document.getSelection().paragraphs.getFirst();
    paragraph.load("text");
    await context.sync();
    const text = paragraph.text;
    const second = /^\s*\S+\s+(\S+)/.exec(text);
    if (!second || text.trim().split(/\s+/).length < 6) {
      log("put the cursor in a paragraph of at least 6 words first");
      return;
    }
    await removeAnnotations(context, paragraph);
    const wordStart = second[0].length - second[1].length;
    const purple = critiqueFor(0, text.length, ["(purple suggestion)"], Word.CritiqueColorScheme.lavender);
    const red = critiqueFor(wordStart, second[1].length, ["(red suggestion)"]);

    // Try both lines in one call first; if that fails, one call each, to see which one fails.
    let ids = [];
    try {
      const together = paragraph.insertAnnotations({ critiques: [purple, red] });
      await context.sync();
      ids = together.value;
      log(`inserted both in one call: ${ids.length} underline(s)`);
    } catch (error) {
      log(`inserting both in one call failed: ${describe(error)}`);
      for (const [name, critique] of [["purple", purple], ["red", red]]) {
        try {
          const one = paragraph.insertAnnotations({ critiques: [critique] });
          await context.sync();
          ids.push(...one.value);
          log(`  ${name} alone: inserted`);
        } catch (inner) {
          log(`  ${name} alone: FAILED ${describe(inner)}`);
        }
      }
    }
    for (const id of ids) drawn.add(id);
    for (const entry of await readBack(context, paragraph)) log(`  Word reports an underline on ${preview(entry.text)} (state ${entry.state})`);
    log("LOOK at the paragraph: is the whole paragraph underlined in purple, and the second word in red? Note what you see in your report.");
  });
}

// ---------- 4. The pages on screen ----------

// Ask once which pages are on screen; returns the page numbers. The short form (one round
// trip) first; if Word refuses, the official sample's form (two round trips).
let quickWayWorks = true;

async function visiblePages(context) {
  const pages = context.document.activeWindow.activePane.pagesEnclosingViewport;
  if (quickWayWorks) {
    try {
      pages.load("index");
      await context.sync();
      const indexes = pages.items.map((page) => page.index);
      if (indexes.every((index) => typeof index === "number")) return { pages, indexes };
      throw new Error("the page numbers came back empty");
    } catch (error) {
      quickWayWorks = false;
      log(`  the quick way of asking for pages does not work (${describe(error)}), using the way from Microsoft's sample`);
    }
  }
  pages.load();
  await context.sync();
  for (const page of pages.items) page.load("index");
  await context.sync();
  return { pages, indexes: pages.items.map((page) => page.index) };
}

let watching = 0; // timer id; 0 means not watching
let asking = false; // the previous poll has not finished: skip this one
let lastPages = "";
let timings = [];

async function pollOnce() {
  if (asking) return;
  asking = true;
  const from = performance.now();
  try {
    let indexes = [];
    await Word.run(async (context) => {
      ({ indexes } = await visiblePages(context));
    });
    const took = performance.now() - from;
    timings.push(took);
    const now = indexes.join(",");
    if (now !== lastPages) {
      lastPages = now;
      log(`pages on screen: ${now || "(none)"}  (asked in ${Math.round(took)} ms)`);
    }
  } catch (error) {
    log(`asking for the pages on screen failed: ${describe(error)}`);
    stopWatching();
  } finally {
    asking = false;
  }
}

function stopWatching() {
  if (!watching) return;
  clearInterval(watching);
  watching = 0;
  $("watch-pages").textContent = "Start watching pages";
  $("watch-pages").classList.remove("on");
  if (timings.length > 0) {
    const sorted = [...timings].sort((a, b) => a - b);
    const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    log(`stopped. Asked ${timings.length} times: fastest ${Math.round(sorted[0])} ms, average ${Math.round(average)} ms, slowest ${Math.round(sorted.at(-1))} ms`);
    log("While it was watching: did scrolling or typing in Word feel slower than usual? Note it in your report.");
  }
  log();
}

function toggleWatching() {
  if (watching) {
    stopWatching();
    return;
  }
  if (!Office.context.requirements.isSetSupported("WordApiDesktop", "1.2")) {
    log("this Word does not have WordApiDesktop 1.2, so it cannot say which pages are on screen");
    return;
  }
  log(`=== Watching pages (asking every ${POLL_MS} ms) ===`);
  lastPages = "";
  timings = [];
  watching = setInterval(pollOnce, POLL_MS);
  $("watch-pages").textContent = "Stop watching pages";
  $("watch-pages").classList.add("on");
  pollOnce();
}

// All paragraphs of the pages on screen: one check request per page, lines drawn page-wide.
async function checkVisible() {
  await Word.run(async (context) => {
    let from = performance.now();
    const { pages, indexes } = await visiblePages(context);
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
    const reading = performance.now() - from;
    const characters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    log(`pages ${indexes.join(",")}: ${paragraphs.length} paragraph(s), ${characters} characters, read in ${Math.round(reading)} ms`);
    const odd = oddCharacters(paragraphs.map((paragraph) => paragraph.text).join(""));
    if (odd.length > 0) log(`  invisible characters in these pages (codes): ${odd.join(", ")}`);

    // Send for checking, in batches when too long; usually one screen is one batch.
    from = performance.now();
    const located = [];
    const chunks = chunkParagraphs(paragraphs);
    for (const chunk of chunks) {
      const { text, spans } = joinParagraphs(chunk.map((index) => ({ text: paragraphs[index].text })));
      for (const item of locateMatches(spans, await check(text))) located.push({ ...item, index: chunk[item.index] });
    }
    log(`  ${chunks.length} request(s) to the server, ${located.length} issue(s), ${Math.round(performance.now() - from)} ms`);

    // Draw: delete existing lines on these paragraphs, then one call per paragraph with issues.
    from = performance.now();
    const byParagraph = new Map();
    for (const item of located) byParagraph.set(item.index, [...(byParagraph.get(item.index) ?? []), item]);
    const old = paragraphs.map((paragraph) => {
      const annotations = paragraph.getAnnotations();
      annotations.load("id");
      return annotations;
    });
    await context.sync();
    for (const annotations of old) for (const annotation of annotations.items) annotation.delete();
    const inserted = [];
    for (const [index, items] of byParagraph) {
      const critiques = items.map((item) => critiqueFor(item.start, item.length, item.match.replacements ?? []));
      inserted.push({ index, items, ids: paragraphs[index].insertAnnotations({ critiques }) });
    }
    await context.sync();
    for (const entry of inserted) for (const id of entry.ids.value) drawn.add(id);
    log(`  underlines drawn on ${byParagraph.size} paragraph(s) in ${Math.round(performance.now() - from)} ms`);

    // Verify which characters each line covers.
    from = performance.now();
    let wrong = 0;
    for (const entry of inserted) {
      const actual = await readBack(context, paragraphs[entry.index]);
      entry.items.forEach((item, position) => {
        const wanted = paragraphs[entry.index].text.slice(item.start, item.start + item.length);
        const got = actual.find((one) => one.id === entry.ids.value[position])?.text;
        if (got === wanted) return;
        wrong++;
        if (wrong <= 10) log(`  WRONG in paragraph ${entry.index}: wanted ${preview(wanted)}, Word underlined ${preview(got)}; paragraph starts ${preview(paragraphs[entry.index].text, 40)}`);
      });
    }
    log(`  checked the positions in ${Math.round(performance.now() - from)} ms`);
    log(wrong === 0 ? `  POSITIONS: all ${located.length} correct` : `  POSITIONS: ${wrong} of ${located.length} are WRONG`);
  });
}

// ---------- 5. Clean up ----------

async function clearAll() {
  const ids = [...drawn];
  let removed = 0;
  // One by one. Word may have removed some already (a suggestion or Ignore was clicked); that is not an error.
  for (const id of ids) {
    try {
      await Word.run(async (context) => {
        context.document.getAnnotationById(id).delete();
        await context.sync();
      });
      removed++;
    } catch {
      // already gone
    }
    drawn.delete(id);
  }
  log(`removed ${removed} of ${ids.length} underline(s) drawn by this page`);
}

// ---------- Copy the log ----------

async function copyLog() {
  const box = $("log");
  let ok = false;
  try {
    await navigator.clipboard.writeText(box.value);
    ok = true;
  } catch {
    // The modern clipboard API may be blocked in Word's task pane: select the text and run the copy command.
    box.focus();
    box.select();
    ok = document.execCommand("copy");
  }
  $("copy-status").textContent = ok ? "Copied." : "Could not copy. Click in the log, press Ctrl+A, then Ctrl+C.";
}

// ---------- Wiring up the buttons ----------

const buttons = {
  environment: () => run("Environment", environment),
  "check-paragraph": () => run("Check this paragraph", checkParagraph),
  "two-colours": () => run("Two colours", twoColours),
  "watch-pages": toggleWatching,
  "check-visible": () => run("Check visible pages", checkVisible),
  clear: () => run("Clear all underlines", clearAll),
  "copy-log": copyLog,
  "clear-log": () => {
    $("log").value = "";
  },
};

// Enable the buttons once Word is ready.
Office.onReady(async (info) => {
  for (const [id, action] of Object.entries(buttons)) $(id).addEventListener("click", action);
  log(`langfAIx technical test, page loaded. Office says: host ${info.host}, platform ${info.platform}`);
  if (info.host !== Office.HostType.Word) {
    log("This page is not running inside Word, so the buttons will not work.");
    return;
  }
  try {
    await registerEvents();
  } catch (error) {
    log(`registering the event handlers failed: ${describe(error)}`);
  }
  log();
});
