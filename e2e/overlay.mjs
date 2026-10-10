// Screenshot check of squiggle alignment.
//
// Opens the extension's own test page (browser-extension/test/fields.html) as a plain
// file and screenshots every kind of field, for a human to confirm that squiggles sit
// right under the wrong text. The extension is not loaded into the browser: the page's
// messages to the background script go to a stand-in, and this script asks the server
// directly. So it runs on Chrome too.
//
// Usage (in the e2e folder):
//   npm install          first time only
//   npm run overlay -- https://your-server/api
//
// Screenshots go to shots/, named overlay-*. Besides the screenshots it checks a number
// of things automatically (see the final output); any failure makes the run FAIL.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

// Two pure-logic modules of the extension, used directly so the stand-in behaves like the real background script.
import { addWord, buildIndex, emptyDictionary, filterMatches } from "../browser-extension/lib/dictionary.js";
import { EMPTY_STATS, addToStats, averageUsd } from "../browser-extension/lib/estimate.js";
import { formatEstimate } from "../browser-extension/lib/format.js";
import { fakeImprove, splitSentences } from "./fake-ai.mjs";

const API = process.argv[2];
if (!API) {
  console.error("Usage: npm run overlay -- https://your-server.example.com/api");
  process.exit(2);
}

const PAGE = new URL("../browser-extension/test/fields.html", import.meta.url).href;
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

// --allow-file-access-from-files: lets a page opened from a local file load script modules from its folder.
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });

const problems = [];
page.on("pageerror", (error) => problems.push(String(error)));

// The stand-in for messages to the background script.
//   sent      every text sent for a rule check
//   improved  every text sent to the AI. Must stay empty until the user clicks an AI button
//   opened    how often the options page was requested
//   stats     what earlier AI calls cost, for the estimate. The real extension keeps it in chrome.storage.local
const sent = [];
const improved = [];
let opened = 0;
let stats = EMPTY_STATS;
// The team glossary switch (the one in the settings), every lookup input, and the copied text.
let glossaryOn = true;
// The personal dictionary. The real extension keeps it in chrome.storage.local; here it
// is a variable. The rules are the extension's own lib/dictionary.js.
let dictionary = emptyDictionary();
const lookups = [];
const copied = [];
// A small made-up glossary for lookups.
const FAKE_TERMS = [
  { id: 1, zh: "归档中心", en: "Archiving Center", category: "Feature", applies_to: "before 3.1.60", variants: [], note: "" },
  { id: 2, zh: "归档中心", en: "Archive Center", category: "Feature", applies_to: "3.1.60 and later", variants: [], note: "" },
  { id: 3, zh: "策略", en: "Policies", category: "Feature", applies_to: "", variants: [], note: "" },
];
await page.exposeFunction("__langfaixSend", async (message) => {
  if (message.type === "improve") {
    improved.push(message.text);
    await new Promise((resolve) => setTimeout(resolve, 400)); // simulate waiting for the AI
    const reply = fakeImprove(message.text);
    if (reply.ok) stats = addToStats(stats, reply.data); // like the real background script: record what this cost
    return reply;
  }
  if (message.type === "estimate") {
    return { ok: true, data: { usd: averageUsd(stats) } };
  }
  // The glossary switch and the card's lookup, handled by the background script in the real extension.
  if (message.type === "glossary-state") return { ok: true, data: { on: glossaryOn } };
  if (message.type === "set-glossary") {
    glossaryOn = Boolean(message.on);
    return { ok: true, data: { on: glossaryOn } };
  }
  if (message.type === "dictionary-add") {
    const result = addWord(dictionary, message.word);
    dictionary = result.dictionary;
    return result.problem ? { ok: false, error: result.problem } : { ok: true, data: { added: result.added, problem: "" } };
  }
  if (message.type === "lookup") {
    lookups.push(message.query);
    const wanted = message.query.trim().toLowerCase();
    return { ok: true, data: { results: FAKE_TERMS.filter((row) => [row.zh, row.en].some((value) => value.toLowerCase().includes(wanted))) } };
  }
  if (message.type === "open-options") {
    opened++;
    return { ok: true };
  }
  if (message.type !== "check") return { ok: false, error: "not supported in this test" };
  sent.push(message.text);
  const response = await fetch(`${API}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The server's real glossary is not used: it changes, and test results must not. For an
    // old backend that ignores the glossary field, glossary issues are removed again below.
    body: JSON.stringify({ text: message.text, language: "en-US", glossary: false }),
  });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  const data = await response.json();
  data.matches = data.matches.filter((match) => match.rule_id !== "GLOSSARY_TERM");
  // An old backend returns no sentence boundaries: add them here, so the test does not depend on the backend version.
  if (!data.sentences || data.sentences.length === 0) data.sentences = splitSentences(message.text);
  // The field in group E of the test page: pretend the team glossary has these two rows and
  // add the two issues the backend would generate, in glossary.py's format. This tests how
  // the extension shows them without putting anything into a real glossary.
  if (message.text.startsWith("Go to ") && glossaryOn) {
    for (const [found, standard, note] of [
      ["策略", "Policies", '"策略" is "Policies" in English (team glossary).'],
      ["Web UI", "WebUI", 'Use "WebUI" instead of "Web UI" (team glossary).'],
    ]) {
      const offset = message.text.indexOf(found);
      if (offset === -1 || data.matches.some((match) => match.offset === offset)) continue;
      data.matches.push({
        offset,
        length: found.length,
        text: found,
        message: note,
        short_message: "Terminology",
        replacements: [standard],
        rule_id: "GLOSSARY_TERM",
        rule_description: "Team glossary",
        category: "TERMINOLOGY",
        issue_type: "terminology",
      });
    }
    data.matches.sort((a, b) => a.offset - b.offset);
  }
  // Like the real background script: filter through the personal dictionary before replying.
  data.matches = filterMatches(data.matches, buildIndex(dictionary));
  return { ok: true, data };
});
await page.exposeFunction("__langfaixCopied", (text) => copied.push(text));
await page.addInitScript(() => {
  window.chrome = { runtime: { id: "test", sendMessage: (message) => window.__langfaixSend(message) } };
  // A headless browser has no usable clipboard: a stand-in records the text.
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => window.__langfaixCopied(text) } });
});

await page.goto(PAGE);

async function shoot(name, id, pad = 10) {
  const element = page.locator(`#${id}`);
  await element.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const box = await element.boundingBox();
  await page.screenshot({
    path: join(SHOTS, `overlay-${name}.png`),
    clip: { x: Math.max(box.x - pad, 0), y: Math.max(box.y - pad, 0), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
}

// Click into a field and wait for the check result.
async function focus(id, wait = 1800) {
  await page.locator(`#${id}`).click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(wait);
}

const setScroll = (id, values) =>
  page.locator(`#${id}`).evaluate((element, v) => {
    if (v.top !== undefined) element.scrollTop = v.top === "end" ? element.scrollHeight : v.top;
    if (v.left !== undefined) element.scrollLeft = v.left === "end" ? element.scrollWidth : v.left;
  }, values);

// Number of rich-text highlights registered on the page.
const highlightCount = () => page.evaluate(() => CSS.highlights.get("langfaix-error")?.size ?? 0);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// ---------- A. textarea ----------

await focus("plain");
await shoot("A1-plain", "plain");

await focus("big");
await shoot("A2-big-font", "big");

await focus("long");
await shoot("A3-long-top", "long");
await setScroll("long", { top: 70 });
await page.waitForTimeout(200);
await shoot("A3-long-scrolled", "long");

await focus("mono");
await setScroll("mono", { left: "end" });
await page.waitForTimeout(200);
await shoot("A4-no-wrap-end", "mono");

await setScroll("scrollbox", { top: 60 });
await focus("inner");
await setScroll("scrollbox", { top: 110 });
await page.waitForTimeout(200);
await shoot("A5-in-panel-scrolled", "scrollbox", 4);

await focus("emoji");
await shoot("A6-emoji", "emoji");

// Spellcheck turned off by the page but a normal font: still checked (as with Google Translate).
await focus("nospell-prose");
await shoot("A7-spellcheck-off-prose", "nospell-prose");
expect(sent.at(-1).includes("still checked"), "a textarea with spellcheck off and a normal font was not checked");

let before = sent.length;
await focus("nospell", 1200);
await page.locator("#readonly").click();
await page.waitForTimeout(1200);
expect(sent.length === before, "a textarea that must be skipped was sent to the server");

// Typing at the start: until the new result arrives, old squiggles move with the text.
await page.locator("#plain").click();
await page.waitForTimeout(1800);
await page.locator("#plain").evaluate((element) => element.setSelectionRange(0, 0));
await page.keyboard.type("Well, ");
await page.waitForTimeout(120);
await shoot("A8-typing-before-recheck", "plain");
await page.waitForTimeout(2000);

// ---------- B. input ----------

await focus("input-plain");
await shoot("B1-input-plain", "input-plain");

await focus("input-tall");
await shoot("B2-input-tall", "input-tall");

await focus("input-long");
await shoot("B3-input-long-start", "input-long");
await page.keyboard.press("End");
await page.waitForTimeout(300);
await shoot("B3-input-long-end", "input-long");

await focus("input-right");
await shoot("B4-input-right", "input-right");

// One word: no check. Checked once there is a second word.
before = sent.length;
await focus("input-oneword", 1500);
expect(sent.length === before, "a single word in an input was sent to the server");
await page.keyboard.press("End");
await page.keyboard.type(" teh mesage");
await page.waitForTimeout(2200);
expect(sent.length === before + 1, "an input with several words was not checked");
await shoot("B5-input-second-word", "input-oneword");

// Single-line inputs that must not be checked: after a click, no text may be sent.
before = sent.length;
const mustSkip = ["input-password", "input-shown-password", "input-email", "input-search", "input-name", "input-card", "input-otp", "input-searchbox"];
for (const id of mustSkip) {
  await page.locator(`#${id}`).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" more wrods");
  await page.waitForTimeout(1100);
}
const leaked = sent.slice(before);
expect(leaked.length === 0, `sensitive inputs were sent to the server: ${JSON.stringify(leaked)}`);
await shoot("B6-input-password", "input-shown-password");

// ---------- C. contenteditable ----------

await focus("rich-plain");
await shoot("C1-rich-plain", "rich-plain");
expect((await highlightCount()) > 0, "no highlight was registered for the simple editor");

await focus("rich-mail");
await shoot("C2-rich-mail", "rich-mail");
const mailText = sent.at(-1);
// Paragraphs are separated by a line break; the end of one must not run into the start of the next.
expect(mailText.includes("Hi team,\nPlease review"), `paragraphs were glued together: ${JSON.stringify(mailText)}`);
expect(mailText.includes("very importent that"), `a word split by bold was not joined: ${JSON.stringify(mailText)}`);

await focus("rich-br");
await shoot("C3-rich-br", "rich-br");
expect(sent.at(-1).includes("fine.\nSecond line"), `line breaks were lost: ${JSON.stringify(sent.at(-1))}`);

await focus("rich-chip");
await shoot("C4-rich-chip", "rich-chip");
expect(!sent.at(-1).includes("Jhon"), `the non-editable chip was sent: ${JSON.stringify(sent.at(-1))}`);
expect(!/ {2}/.test(sent.at(-1)), `skipping the chip left a double space: ${JSON.stringify(sent.at(-1))}`);

await focus("rich-scroll");
await setScroll("rich-scroll", { top: "end" });
await page.waitForTimeout(200);
await shoot("C5-rich-scrolled", "rich-scroll");

await focus("rich-reply");
await shoot("C6-rich-reply", "rich-reply");
expect(sent.at(-1).includes("confguration"), `the reply text was not checked: ${JSON.stringify(sent.at(-1))}`);
expect(!/chekc|sistem|Alex/.test(sent.at(-1)), `quoted email text was sent: ${JSON.stringify(sent.at(-1))}`);

// Some pages replace the editing area's elements wholesale without changing the text. Squiggles must survive that.
await focus("rich-plain");
await page.locator("#rich-plain").evaluate((element) => {
  element.innerHTML = element.innerHTML; // same content, all nodes new
});
await page.waitForTimeout(300);
const stillAttached = await page.evaluate(() => {
  const highlight = CSS.highlights.get("langfaix-error");
  return Boolean(highlight) && [...highlight].every((range) => range.startContainer.isConnected && !range.collapsed);
});
expect(stillAttached, "underlines were lost after the page rebuilt the editor content");
await shoot("C8-rich-after-rebuild", "rich-plain");

// Spellcheck turned off by the page but a normal font: still checked (TinyMCE's default).
await focus("rich-nospell-prose");
await shoot("C7-spellcheck-off-prose", "rich-nospell-prose");
expect(sent.at(-1).includes("still checked"), "an editor with spellcheck off and a normal font was not checked");
expect((await highlightCount()) > 0, "no highlight in the editor with spellcheck off and a normal font");

before = sent.length;
await focus("rich-nospell", 1200);
expect(sent.length === before, "a code editor (spellcheck off, fixed-width font) was sent to the server");

// Typing at the start of rich text: squiggles move with the text.
await page.locator("#rich-plain").click({ position: { x: 5, y: 5 } });
await page.waitForTimeout(1800);
await page.keyboard.press("Control+Home");
await page.keyboard.type("Well, ");
await page.waitForTimeout(150);
await shoot("C7-rich-typing-before-recheck", "rich-plain");
await page.waitForTimeout(2000);
await shoot("C7-rich-typing-after-recheck", "rich-plain");

// ---------- D. Suggestion card: hover a squiggle, click a suggestion ----------

const card = page.locator("langfaix-popup .card");

// Move the pointer onto an underlined word. False if the word is not found.
async function hoverWord(word) {
  const marks = await page.evaluate(() => window.__langfaix.inspect());
  const mark = marks.find((item) => item.text === word);
  if (!mark) return false;
  const x = (mark.left + mark.right) / 2;
  const y = (mark.top + mark.bottom) / 2;
  await page.mouse.move(x - 2, y);
  await page.mouse.move(x, y); // move once more so the browser fires a mousemove
  return true;
}

// Screenshot the field plus the card. The card is usually below and flips above when there is no room, so the union of both is captured.
async function shootWithCard(name, id) {
  const box = await page.locator(`#${id}`).boundingBox();
  const cardBox = (await card.isVisible()) ? await card.boundingBox() : null;
  const top = Math.min(box.y, cardBox?.y ?? box.y);
  const bottom = Math.max(box.y + box.height, cardBox ? cardBox.y + cardBox.height : 0);
  // The card may reach further right than the field (opened from the badge), so the union applies sideways too.
  const right = Math.max(box.x + box.width, cardBox ? cardBox.x + cardBox.width : 0);
  await page.screenshot({
    path: join(SHOTS, `overlay-${name}.png`),
    clip: { x: Math.max(box.x - 10, 0), y: Math.max(top - 14, 0), width: right - box.x + 20, height: bottom - top + 28 },
  });
}

const valueOf = (id) => page.locator(`#${id}`).evaluate((element) => element.value ?? element.innerText);

// D1. textarea: the card appears, a suggestion replaces the text, Ctrl+Z undoes it
await page.locator("#plain").scrollIntoViewIfNeeded();
await focus("plain");
expect(await hoverWord("sentense"), "D1: the word sentense is not underlined in the textarea");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
expect(await card.isVisible(), "D1: no card appeared when hovering a word in the textarea");
await shootWithCard("D1-card-textarea", "plain");
expect((await card.locator(".old").textContent().catch(() => "")) === "sentense", "D1: the card does not show the wrong word");
await card.locator("button.suggestion", { hasText: "sentence" }).first().click();
await page.waitForTimeout(400);
expect((await valueOf("plain")).includes("a test sentence."), `D1: the textarea was not corrected: ${await valueOf("plain")}`);
expect(!(await card.isVisible()), "D1: the card stayed open after applying a suggestion");
expect(await page.evaluate(() => document.activeElement?.id === "plain"), "D1: the textarea lost focus after clicking the card");
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
expect((await valueOf("plain")).includes("sentense"), "D1: Ctrl+Z did not undo the replacement");
await page.waitForTimeout(1800);

// D2. Dismiss: the issue is hidden and stays hidden after a re-check
expect(await hoverWord("erors"), "D2: the word erors is not underlined");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
await card.locator("button.dismiss").click();
await page.waitForTimeout(300);
let marksNow = await page.evaluate(() => window.__langfaix.inspect().map((item) => item.text));
expect(!marksNow.includes("erors"), "D2: the underline stayed after Dismiss");
await page.keyboard.press("Control+End");
await page.keyboard.type(" More text.");
await page.waitForTimeout(2200);
marksNow = await page.evaluate(() => window.__langfaix.inspect().map((item) => item.text));
expect(!marksNow.includes("erors"), "D2: the dismissed word came back after the next check");
expect(marksNow.includes("sentense"), "D2: other underlines disappeared together with the dismissed one");

// D3. The card hides when the pointer leaves, and when typing starts
await hoverWord("sentense");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
await page.mouse.move(5, 5);
await page.waitForTimeout(700);
expect(!(await card.isVisible()), "D3: the card did not close after the mouse moved away");
await hoverWord("sentense");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
await page.keyboard.type("x");
await page.waitForTimeout(200);
expect(!(await card.isVisible()), "D3: the card did not close when typing started");

// D4. Moving from the word onto the card must not hide the card on the way
await page.waitForTimeout(2000);
await hoverWord("sentense");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
const cardBox = await card.boundingBox();
if (cardBox) {
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height - 6, { steps: 8 });
  await page.waitForTimeout(700);
}
expect(await card.isVisible(), "D4: the card closed while the mouse was moving onto it");
await page.mouse.move(5, 5);
await page.waitForTimeout(700);

// D5. Single-line input
await focus("input-plain");
expect(await hoverWord("secend"), "D5: the word secend is not underlined in the input");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
await shootWithCard("D5-card-input", "input-plain");
await card.locator("button.suggestion", { hasText: "second" }).first().click();
await page.waitForTimeout(400);
expect((await valueOf("input-plain")).includes("the second floor"), `D5: the input was not corrected: ${await valueOf("input-plain")}`);

// D6. Rich text: the typo is half bold; after replacing, the whole word is right and nothing else is damaged
await focus("rich-mail");
expect(await hoverWord("importent"), "D6: the word importent is not underlined in the editor");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
await shootWithCard("D6-card-rich", "rich-mail");
await card.locator("button.suggestion", { hasText: "important" }).first().click();
await page.waitForTimeout(400);
// Inserting at a bold boundary, the browser may turn a neighbouring space into a no-break space, which looks the same. Normalise before comparing.
const mailAfter = (await valueOf("rich-mail")).replaceAll(String.fromCharCode(160), " ");
expect(mailAfter.includes("It is very important that everyone reads it."), `D6: the editor was not corrected: ${JSON.stringify(mailAfter)}`);
expect(mailAfter.includes("Hi team,") && mailAfter.includes("release notes"), "D6: other content of the editor was damaged");
expect((await page.locator("#rich-mail p").count()) === 4, "D6: the paragraph structure of the editor changed");
await page.waitForTimeout(1800);
await shoot("D6-rich-after-fix", "rich-mail");

// D7. Near the bottom of the window the card flips above the word instead of leaving the window
await page.setViewportSize({ width: 900, height: 420 });
await page.locator("#rich-plain").evaluate((element) => element.scrollIntoView({ block: "end" }));
await focus("rich-plain");
if (await hoverWord("speling")) {
  await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  const flipped = await card.boundingBox();
  expect(Boolean(flipped) && flipped.y >= 0 && flipped.y + flipped.height <= 420, `D7: the card is outside the window: ${JSON.stringify(flipped)}`);
  await page.screenshot({ path: join(SHOTS, "overlay-D7-card-flipped.png") });
} else {
  expect(false, "D7: the word speling is not underlined");
}
await page.mouse.move(5, 5);
await page.setViewportSize({ width: 900, height: 1000 });
await page.waitForTimeout(600);

// ---------- H. Free "could read better" hint lines (part 1: before the user clicks) ----------

// Reload the test page so every field has its initial content.
await page.reload();
await page.waitForTimeout(300);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allMarks = () => page.evaluate(() => window.__langfaix.inspect());
// The hint lines (lavender) drawn now. One sentence's line may be several pieces; each piece's text is the whole sentence.
const hintMarks = async () => (await allMarks()).filter((item) => item.kind === "hint");
// The sentences hinted now.
const hintedSentences = async () => [...new Set((await hintMarks()).map((item) => item.text))];
const hintHighlightCount = () => page.evaluate(() => CSS.highlights.get("langfaix-hint")?.size ?? 0);
const cardText = async (selector) => (await card.locator(selector).first().textContent().catch(() => "")) ?? "";

// Move the pointer onto a sentence's hint line. start is the beginning of the sentence. False if not found.
async function hoverHint(start) {
  const marks = (await hintMarks()).filter((item) => item.text.startsWith(start));
  if (marks.length === 0) return false;
  // Rest on the widest piece.
  const mark = marks.reduce((a, b) => (b.right - b.left > a.right - a.left ? b : a));
  const x = (mark.left + mark.right) / 2;
  const y = (mark.top + mark.bottom) / 2;
  await page.mouse.move(x - 2, y);
  await page.mouse.move(x, y);
  return true;
}
const waitForCard = () => card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});

// H1. Two or more rule issues in a sentence: a lavender line under the whole sentence, broken at the red lines
await focus("plain");
let hinted = await hintedSentences();
expect(same(hinted, ["This are a test sentense.", "It have two more erors here."]), `H1: wrong sentences hinted in the textarea: ${JSON.stringify(hinted)}`);
expect((await hintMarks()).every((item) => item.reason === "issues"), "H1: the reason should be 'issues'");
await shoot("H1-hint-textarea", "plain");

// H2. A correct but very long sentence: hinted. The short one after it is not.
await focus("hint-long");
hinted = await hintedSentences();
expect(hinted.length === 1 && hinted[0].startsWith("The upgrade package") && hinted[0].endsWith("receiving updates."), `H2: wrong sentences hinted: ${JSON.stringify(hinted)}`);
expect((await hintMarks()).every((item) => item.reason === "long"), "H2: the reason should be 'long'");
await shoot("H2-hint-long", "hint-long");

// H3. A single issue, but a style one (wordiness): hinted
await focus("hint-style");
hinted = await hintedSentences();
expect(same(hinted, ["Please reply back to me when the new build is ready for testing."]), `H3: wrong sentences hinted: ${JSON.stringify(hinted)}`);
expect((await hintMarks()).every((item) => item.reason === "style"), "H3: the reason should be 'style'");
await shoot("H3-hint-style", "hint-style");

// H4. Hovering a hint line shows the hint card. No AI use yet, so no cost estimate. It hides when the pointer leaves.
expect(await hoverHint("Please reply back"), "H4: no hint line to hover");
await waitForCard();
expect(await card.isVisible(), "H4: no card appeared when hovering a hint line");
expect((await cardText(".kind")) === "Improve your text", `H4: wrong card title: ${JSON.stringify(await cardText(".kind"))}`);
expect((await cardText(".message")).includes("wording"), `H4: wrong explanation: ${JSON.stringify(await cardText(".message"))}`);
expect((await cardText("button.improve")) === "Improve with AI", "H4: the card has no Improve with AI button");
expect((await card.locator(".estimate").count()) === 0, "H4: a cost estimate is shown although the AI was never used");
await shootWithCard("H4-hint-card", "hint-style");
await page.mouse.move(5, 5);
await page.waitForTimeout(700);
expect(!(await card.isVisible()), "H4: the hint card did not close after the mouse moved away");

// H5. Dismiss on the hint card: the hint line goes, red lines stay; it does not come back after typing and a re-check
expect(await hoverHint("Please reply back"), "H5: no hint line to hover");
await waitForCard();
await card.locator("button.dismiss").click();
await page.waitForTimeout(300);
expect((await hintedSentences()).length === 0, "H5: the hint line stayed after Dismiss");
expect((await allMarks()).some((item) => item.kind === "rule" && item.text === "reply back"), "H5: Dismiss on the hint also removed the red underline");
await page.keyboard.press("Control+End");
await page.keyboard.type(" Bye.");
await page.waitForTimeout(2200);
hinted = await hintedSentences();
expect(!hinted.some((sentence) => sentence.startsWith("Please reply back")), `H5: the dismissed hint came back after the next check: ${JSON.stringify(hinted)}`);

// H6. Moving from the hint line onto the card: the card must neither hide on the way nor be replaced by a line lying under it
await focus("plain");
expect(await hoverHint("It have"), "H6: no hint line to hover");
await waitForCard();
const hintCardBox = await card.boundingBox();
if (hintCardBox) {
  await page.mouse.move(hintCardBox.x + hintCardBox.width / 2, hintCardBox.y + hintCardBox.height / 2, { steps: 8 });
  await page.waitForTimeout(900);
}
expect((await card.isVisible()) && (await card.locator("button.improve").count()) === 1, "H6: the hint card closed or changed while the mouse was moving onto it");
await page.mouse.move(5, 5);
await page.waitForTimeout(700);

// H7. Rich-text area: hint lines are a separate highlight group
await focus("rich-plain");
expect((await hintHighlightCount()) > 0, "H7: no hint highlight was registered in the editor");
hinted = await hintedSentences();
expect(same(hinted, ["This editor have a mistake and a speling eror."]), `H7: wrong sentences hinted in the editor: ${JSON.stringify(hinted)}`);
await shoot("H7-hint-rich", "rich-plain");
expect(await hoverHint("This editor"), "H7: no hint line to hover in the editor");
await waitForCard();
expect((await card.locator("button.improve").count()) === 1, "H7: no hint card in the editor");
await shootWithCard("H7-hint-card-rich", "rich-plain");
await page.mouse.move(5, 5);
await page.waitForTimeout(700);

// H8. Single-line input
await focus("input-plain");
hinted = await hintedSentences();
expect(same(hinted, ["Printer on the secend floor dont work"]), `H8: wrong sentences hinted in the input: ${JSON.stringify(hinted)}`);
await shoot("H8-hint-input", "input-plain");

// H9. At most one ordinary error per sentence: no hints. Hint lines must not be everywhere.
await focus("long");
hinted = await hintedSentences();
expect(hinted.length === 0, `H9: sentences with a single ordinary mistake were hinted: ${JSON.stringify(hinted)}`);

// ---------- E. AI rewriting: only on a click ----------

// The most important check: after everything in A to H (clicking into fields, hovering
// red lines, picking suggestions, Dismiss, hint lines, hint cards), no text may have been
// sent to the AI.
expect(improved.length === 0, `text was sent to the AI before any AI button was clicked: ${JSON.stringify(improved)}`);

// Reload the test page so every field has its initial content.
await page.reload();
await page.waitForTimeout(300);

const aiLink = card.locator("button.ai");
const costText = async () => (await card.locator(".cost").first().textContent().catch(() => "")) ?? "";
const texts = (selector) => card.locator(selector).allTextContents();

// Hover an underlined word, wait for the rule card, click its AI entry.
async function askAi(word) {
  if (!(await hoverWord(word))) return false;
  await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  if (!(await aiLink.isVisible().catch(() => false))) return false;
  await aiLink.click();
  return true;
}
const waitFor = (selector) => card.locator(selector).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

// E1. textarea: only that sentence is sent; the card shows deletions and additions; the cost line format; Accept fixes the text
await focus("plain");
expect(await hoverWord("sentense"), "E1: sentense is not underlined");
await card.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
expect(await aiLink.isVisible().catch(() => false), "E1: the rule card has no AI entry");
expect(improved.length === 0, "E1: text was sent to the AI just by showing the card");
await aiLink.click();
await page.waitForTimeout(120);
expect((await card.locator(".waiting").count()) === 1, "E1: no waiting state while the AI is working");
await waitFor(".diff");
expect(improved.length === 1 && improved[0] === "This are a test sentense.", `E1: the AI should get only the one sentence, got ${JSON.stringify(improved)}`);
expect(same(await texts(".removed"), ["This are", "sentense"]), `E1: struck-out words are wrong: ${JSON.stringify(await texts(".removed"))}`);
expect(same(await texts(".added"), ["These are", "sentence"]), `E1: added words are wrong: ${JSON.stringify(await texts(".added"))}`);
expect((await costText()) === "520 tokens (in 410, cached 300 / out 110) · US$0.0010", `E1: cost line is wrong: ${JSON.stringify(await costText())}`);
expect((await texts(".reasons li")).length === 2, "E1: the reasons are not listed");
expect(same(await texts(".model"), ["Model: fake-model"]), `E1: the card should name the model once: ${JSON.stringify(await texts(".model"))}`);
await shootWithCard("E1-ai-card-textarea", "plain");
await card.locator("button.accept").click();
await page.waitForTimeout(400);
expect((await valueOf("plain")) === "These are a test sentence. It have two more erors here.", `E1: Accept did not fix the textarea: ${JSON.stringify(await valueOf("plain"))}`);
expect(!(await card.isVisible()), "E1: the card stayed open after Accept");
expect(await page.evaluate(() => document.activeElement?.id === "plain"), "E1: the textarea lost focus after Accept");
await page.waitForTimeout(1800);

// E2. The AI card is pinned: it stays when the pointer leaves or passes other red lines; a click elsewhere closes it
expect(await askAi("erors"), "E2: could not open the AI card for the second sentence");
await waitFor(".diff");
expect(improved.at(-1) === "It have two more erors here.", `E2: wrong sentence sent: ${JSON.stringify(improved.at(-1))}`);
await page.mouse.move(5, 5);
await page.waitForTimeout(800);
expect((await card.locator(".kind.ai").count()) === 1, "E2: the AI card closed when the mouse moved away");
await hoverWord("It have");
await page.waitForTimeout(500);
expect((await card.locator(".kind.ai").count()) === 1, "E2: hovering another underline replaced the AI card");
await page.locator("#plain").click({ position: { x: 600, y: 40 } });
await page.waitForTimeout(300);
expect(!(await card.isVisible()), "E2: clicking elsewhere did not close the AI card");

// E3. Asking again for the same sentence: the earlier result is reused, nothing is sent, and the card says it was not charged again
const callsBefore = improved.length;
expect(await askAi("erors"), "E3: could not reopen the AI card");
await waitFor(".diff");
expect(improved.length === callsBefore, "E3: the same sentence was sent to the AI a second time");
expect(((await card.locator(".note").textContent().catch(() => "")) ?? "").includes("Not charged again"), "E3: the card does not say it was not charged again");
await card.locator("button.dismiss").click();
await page.waitForTimeout(300);
expect((await valueOf("plain")).includes("It have two more erors"), "E3: Dismiss changed the text");

// E4. The AI finds nothing to change: no Accept, but the cost is shown
await focus("long");
await setScroll("long", { top: 70 });
await page.waitForTimeout(300);
expect(await askAi("speling"), "E4: could not open the AI card in the long textarea");
await waitFor(".cost");
expect(improved.at(-1) === "Eighth line contains a speling mistake.", `E4: wrong sentence sent: ${JSON.stringify(improved.at(-1))}`);
expect((await costText()) === "AI checked, no change needed · 420 tokens · < US$0.0001", `E4: cost line is wrong: ${JSON.stringify(await costText())}`);
expect((await card.locator("button.accept").count()) === 0, "E4: Accept is offered although nothing changed");
await shootWithCard("E4-ai-no-change", "long");
await card.locator("button.dismiss").click();

// E5. Budget used up: the server's reason is shown
await focus("big");
expect(await askAi("dont"), "E5: could not open the AI card in the big textarea");
await waitFor(".problem");
expect(((await card.locator(".problem").first().textContent().catch(() => "")) ?? "").includes("Budget has been exceeded"), "E5: the budget message is not shown");
expect((await card.locator("button.accept").count()) === 0, "E5: a budget error should not offer a button to the options page");
await card.locator("button.dismiss").click();

// E6. Rich text: without a key there is a button to the options page
await focus("rich-mail");
expect(await askAi("detials"), "E6: could not open the AI card in the editor");
await waitFor(".problem");
expect(((await card.locator(".problem").first().textContent().catch(() => "")) ?? "").includes("API key is not set"), "E6: the missing-key message is not shown");
await shootWithCard("E6-ai-no-key", "rich-mail");
await card.locator("button.accept", { hasText: "Open options" }).click();
await page.waitForTimeout(200);
expect(opened === 1, "E6: the button did not ask to open the options page");

// E7. Rich text: two edits applied together; bold and other formatting must survive
expect(await askAi("documant"), "E7: could not open the AI card for the first sentence of the editor");
await waitFor(".diff");
expect(improved.at(-1) === "Please review the attached documant before friday.", `E7: wrong sentence sent: ${JSON.stringify(improved.at(-1))}`);
await shootWithCard("E7-ai-card-rich", "rich-mail");
await card.locator("button.accept").click();
await page.waitForTimeout(500);
const richAfter = (await valueOf("rich-mail")).replaceAll(String.fromCharCode(160), " ");
expect(richAfter.includes("Please review the attached document before Friday."), `E7: the editor was not fixed: ${JSON.stringify(richAfter)}`);
expect((await page.locator("#rich-mail b").first().textContent()) === "attached", "E7: the bold word was damaged");
expect((await page.locator("#rich-mail p").count()) === 4, "E7: the paragraphs of the editor changed");

// E8. Single-line input: two edits
await focus("input-plain");
expect(await askAi("secend"), "E8: could not open the AI card in the input");
await waitFor(".diff");
await card.locator("button.accept").click();
await page.waitForTimeout(400);
expect((await valueOf("input-plain")) === "Printer on the second floor does not work", `E8: the input was not fixed: ${JSON.stringify(await valueOf("input-plain"))}`);
await page.waitForTimeout(600);

// ---------- H (part 2): after the user clicked the button on a hint card ----------

await page.reload();
await page.waitForTimeout(300);

// H10. The AI has been used by now, so the hint card shows a cost estimate. Nothing is sent
// when the card appears; the click sends just that sentence. Accept fixes it.
await focus("plain");
let calls = improved.length;
expect(await hoverHint("It have"), "H10: no hint line to hover");
await waitForCard();
const expectedEstimate = formatEstimate(averageUsd(stats));
expect(expectedEstimate !== "" && (await cardText(".estimate")) === expectedEstimate, `H10: the estimate should be ${JSON.stringify(expectedEstimate)}, got ${JSON.stringify(await cardText(".estimate"))}`);
expect(improved.length === calls, "H10: showing the hint card sent text to the AI");
await shootWithCard("H10-hint-card-estimate", "plain");
await card.locator("button.improve").click();
await waitFor(".diff");
expect(improved.length === calls + 1 && improved.at(-1) === "It have two more erors here.", `H10: the AI should get only the hinted sentence, got ${JSON.stringify(improved.slice(calls))}`);
await shootWithCard("H10-hint-to-ai-card", "plain");
await card.locator("button.accept").click();
await page.waitForTimeout(2200);
expect((await valueOf("plain")) === "This are a test sentense. It has two more errors here.", `H10: Accept did not fix the sentence: ${JSON.stringify(await valueOf("plain"))}`);
hinted = await hintedSentences();
expect(same(hinted, ["This are a test sentense."]), `H10: after Accept only the other sentence should still be hinted: ${JSON.stringify(hinted)}`);

// H11. Dismiss after seeing the AI's edits: text unchanged, red lines stay, this sentence's hint line goes
expect(await hoverHint("This are"), "H11: no hint line to hover");
await waitForCard();
await card.locator("button.improve").click();
await waitFor(".diff");
await card.locator("button.dismiss").click();
await page.waitForTimeout(300);
expect((await valueOf("plain")).startsWith("This are a test sentense."), "H11: Dismiss changed the text");
expect((await hintedSentences()).length === 0, "H11: the hint line stayed after the AI suggestion was dismissed");
expect((await allMarks()).some((item) => item.kind === "rule" && item.text === "sentense"), "H11: the red underlines disappeared together with the hint");

// H12. A long sentence: still long after the accepted AI edit, but written by the AI now, so no new hint
await focus("hint-long");
expect(await hoverHint("The upgrade package"), "H12: no hint line to hover");
await waitForCard();
await card.locator("button.improve").click();
await waitFor(".diff");
await shootWithCard("H12-long-ai-card", "hint-long");
await card.locator("button.accept").click();
await page.waitForTimeout(2200);
expect((await valueOf("hint-long")).includes("every customer install it before"), `H12: Accept did not change the long sentence: ${JSON.stringify(await valueOf("hint-long"))}`);
hinted = await hintedSentences();
expect(hinted.length === 0, `H12: the sentence the AI just rewrote is hinted again: ${JSON.stringify(hinted)}`);

// H13. Rich text: the AI finds nothing to change. The hint line goes as soon as the result arrives (not only when the card closes); red lines stay.
await focus("rich-plain");
calls = improved.length;
expect(await hoverHint("This editor"), "H13: no hint line to hover in the editor");
await waitForCard();
await card.locator("button.improve").click();
await waitFor(".cost");
expect(improved.length === calls + 1 && improved.at(-1) === "This editor have a mistake and a speling eror.", `H13: wrong text sent: ${JSON.stringify(improved.slice(calls))}`);
expect((await costText()).startsWith("AI checked, no change needed"), `H13: cost line is wrong: ${JSON.stringify(await costText())}`);
expect((await hintHighlightCount()) === 0, "H13: the hint line stayed although the AI said nothing needs to change");
expect((await highlightCount()) > 0, "H13: the red underlines disappeared together with the hint");
await shootWithCard("H13-rich-no-change", "rich-plain");
await card.locator("button.dismiss").click();
await page.waitForTimeout(300);

// ---------- G. The corner badge and its menu ----------

await page.reload();
await page.waitForTimeout(300);

const dot = page.locator("langfaix-badge .dot");
const menu = page.locator("langfaix-badge .menu");
const menuLabels = () => menu.locator("button.item .label").allTextContents();
const menuItem = (label) => menu.locator("button.item", { hasText: label });
const focusedId = () => page.evaluate(() => document.activeElement?.id ?? "");
const boxOf = (id) => page.locator(`#${id}`).boundingBox();

// Click the badge and wait for the menu. Returns whether it opened.
async function openMenu() {
  await dot.click();
  await menu.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  return menu.isVisible();
}

// Screenshot the field plus the menu.
async function shootWithMenu(name, id) {
  const box = await boxOf(id);
  const menuBox = (await menu.isVisible()) ? await menu.boundingBox() : null;
  const top = Math.min(box.y, menuBox?.y ?? box.y);
  const bottom = Math.max(box.y + box.height, menuBox ? menuBox.y + menuBox.height : 0);
  await page.screenshot({
    path: join(SHOTS, `overlay-${name}.png`),
    clip: { x: Math.max(box.x - 10, 0), y: Math.max(top - 14, 0), width: box.width + 20, height: bottom - top + 28 },
  });
}

// G1. Multi-line field: the badge is inside at the bottom right and shows the issue count
await focus("plain");
expect(await dot.isVisible(), "G1: no badge in the corner of the textarea");
expect((await dot.textContent()) === "5", `G1: the badge should show 5 issues, shows ${JSON.stringify(await dot.textContent())}`);
let fieldBox = await boxOf("plain");
let dotBox = await dot.boundingBox();
expect(
  Boolean(dotBox) &&
    dotBox.x + dotBox.width <= fieldBox.x + fieldBox.width &&
    dotBox.y + dotBox.height <= fieldBox.y + fieldBox.height &&
    dotBox.x > fieldBox.x + fieldBox.width - 60 &&
    dotBox.y > fieldBox.y + fieldBox.height - 40,
  `G1: the badge is not inside the bottom-right corner: ${JSON.stringify(dotBox)} in ${JSON.stringify(fieldBox)}`,
);

// G2. Clicking the badge opens the menu; nothing is sent and the field keeps focus. Nothing
// is selected, so only "this sentence" and "whole text" are offered.
calls = improved.length;
expect(await openMenu(), "G2: clicking the badge did not open the menu");
expect(same(await menuLabels(), ["Improve this sentence", "Improve whole text"]), `G2: wrong menu items: ${JSON.stringify(await menuLabels())}`);
expect(((await menuItem("Improve whole text").locator(".detail").textContent().catch(() => "")) ?? "").startsWith("2 sentences, about US$"), "G2: the whole-text item should say how many sentences and about how much");
expect(improved.length === calls, "G2: opening the menu sent text to the AI");
expect((await focusedId()) === "plain", "G2: the textarea lost focus when the badge was clicked");
await shootWithMenu("G2-badge-menu", "plain");
// With the menu open, hovering a red line shows no card, so the menu is not covered.
await hoverWord("sentense");
await page.waitForTimeout(500);
expect(!(await card.isVisible()), "G2: a suggestion card opened on top of the menu");
// A second click on the badge closes the menu; so does a key press.
await dot.click();
await page.waitForTimeout(200);
expect(!(await menu.isVisible()), "G2: clicking the badge again did not close the menu");
await openMenu();
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
expect(!(await menu.isVisible()), "G2: pressing a key did not close the menu");

// G3. Improve this sentence: the sentence at the caret is sent (the caret is put into the second one)
await page.locator("#plain").evaluate((element) => element.setSelectionRange(40, 40));
await openMenu();
await menuItem("Improve this sentence").click();
await page.waitForTimeout(120);
expect((await cardText(".note")) === "Only this sentence is sent.", `G3: wrong note while waiting: ${JSON.stringify(await cardText(".note"))}`);
await waitFor(".diff");
expect(improved.length === calls + 1 && improved.at(-1) === "It have two more erors here.", `G3: wrong text sent: ${JSON.stringify(improved.slice(calls))}`);
expect((await focusedId()) === "plain", "G3: the textarea lost focus after picking a menu item");
await shootWithCard("G3-sentence-from-menu", "plain");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// G4. Improve selection: offered only with a selection, and exactly the selection is sent.
// It spans two sentences: two sections with a checkbox each. Untick the first, accept the second.
await page.locator("#plain").evaluate((element) => element.setSelectionRange(16, 33));
calls = improved.length;
await openMenu();
expect(same(await menuLabels(), ["Improve this sentence", "Improve selection", "Improve whole text"]), `G4: wrong menu items with a selection: ${JSON.stringify(await menuLabels())}`);
await menuItem("Improve selection").click();
await page.waitForTimeout(120);
expect((await cardText(".note")) === "Only the selected text is sent.", `G4: wrong note while waiting: ${JSON.stringify(await cardText(".note"))}`);
await waitFor(".diff");
expect(improved.length === calls + 1 && improved.at(-1) === "sentense. It have", `G4: wrong text sent: ${JSON.stringify(improved.slice(calls))}`);
expect((await card.locator("input.pick").count()) === 2, "G4: each changed sentence should have a checkbox");
expect((await cardText(".cost.total")) === "Total for 2 sentences · 1040 tokens · US$0.0020", `G4: wrong total line: ${JSON.stringify(await cardText(".cost.total"))}`);
await shootWithCard("G4-selection-two-sentences", "plain");
await card.locator("input.pick").first().uncheck();
await card.locator("button.accept", { hasText: "Accept selected" }).click();
await page.waitForTimeout(400);
expect((await valueOf("plain")) === "This are a test sentense. It has two more erors here.", `G4: only the ticked sentence should change: ${JSON.stringify(await valueOf("plain"))}`);
await page.waitForTimeout(1800);

// G5. Improve whole text: a ten-line field sent whole; one section per sentence, a total
// at the bottom. Only one sentence has edits, so no checkboxes.
await focus("long");
calls = improved.length;
await openMenu();
expect(((await menuItem("Improve whole text").locator(".detail").textContent().catch(() => "")) ?? "").startsWith("10 sentences, about US$"), "G5: the whole-text item should say 10 sentences");
await menuItem("Improve whole text").click();
await page.waitForTimeout(120);
expect((await cardText(".note")) === "The whole text of this box is sent.", `G5: wrong note while waiting: ${JSON.stringify(await cardText(".note"))}`);
await waitFor(".diff");
const longText = await valueOf("long");
expect(improved.length === calls + 1 && improved.at(-1) === longText, "G5: the whole text should be sent in one request");
expect((await card.locator(".section").count()) === 10, `G5: expected 10 sections, got ${await card.locator(".section").count()}`);
expect((await card.locator("input.pick").count()) === 0, "G5: checkboxes are not needed when only one sentence changed");
expect((await cardText(".cost.total")).startsWith("Total for 10 sentences · "), `G5: wrong total line: ${JSON.stringify(await cardText(".cost.total"))}`);
// Ten sentences, the model named once, not once per sentence.
expect(same(await texts(".model"), ["Model: fake-model"]), `G5: the model should be named once for the whole card: ${JSON.stringify(await texts(".model"))}`);
const tallCard = await card.boundingBox();
expect(Boolean(tallCard) && tallCard.y >= 0 && tallCard.y + tallCard.height <= 1000, `G5: the long card is outside the window: ${JSON.stringify(tallCard)}`);
// The sentence list is long, but Accept and the total are visible without scrolling.
const acceptBox = await card.locator("button.accept").boundingBox();
const totalBox = await card.locator(".cost.total").boundingBox();
expect(
  Boolean(acceptBox) && Boolean(totalBox) && totalBox.y >= tallCard.y && acceptBox.y + acceptBox.height <= tallCard.y + tallCard.height,
  `G5: the Accept button or the total line is scrolled out of the card: ${JSON.stringify({ acceptBox, totalBox, tallCard })}`,
);
await page.screenshot({ path: join(SHOTS, "overlay-G5-whole-text.png") });
await card.locator("button.accept").click();
await page.waitForTimeout(2200);
expect((await valueOf("long")).includes("These are the second line with a mistake."), "G5: Accept did not apply the change");
expect((await valueOf("long")).includes("Eighth line contains a speling mistake."), "G5: Accept changed a sentence the AI left alone");
// After the whole text was sent, each sentence is remembered: clicking one from a rule card costs nothing more.
calls = improved.length;
await setScroll("long", { top: 70 });
await page.waitForTimeout(300);
expect(await askAi("speling"), "G5: could not open the AI card for one of the sentences");
await waitFor(".cost");
expect(improved.length === calls, "G5: a sentence that was part of the whole-text request was sent again");
expect((await cardText(".note")).includes("Not charged again"), "G5: the card does not say it was not charged again");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// G6. Over the limit (31 sentences, limit 30): the whole-text item is disabled and says why
await page.locator("#hint-style").fill("Ok now. ".repeat(31).trim());
await page.waitForTimeout(2000);
// This textarea is two lines tall, so the badge straddles the edge. It must not cover the resize handle.
fieldBox = await boxOf("hint-style");
dotBox = await dot.boundingBox();
expect(Boolean(dotBox) && dotBox.x + dotBox.width <= fieldBox.x + fieldBox.width - 10, `G6: the badge covers the resize handle of a short textarea: ${JSON.stringify(dotBox)} in ${JSON.stringify(fieldBox)}`);
calls = improved.length;
await openMenu();
const wholeItem = menuItem("Improve whole text");
expect(await wholeItem.isDisabled().catch(() => false), "G6: the whole-text item should be disabled over the limit");
expect(((await wholeItem.locator(".detail").textContent().catch(() => "")) ?? "") === "Too many sentences: 31 (the limit is 30).", "G6: the reason is not shown");
await shootWithMenu("G6-over-limit", "hint-style");
await wholeItem.click({ force: true }).catch(() => {});
await page.waitForTimeout(600);
expect(improved.length === calls && !(await card.isVisible()), "G6: a disabled item still sent text to the AI");
await page.keyboard.press("Escape");

// G7. Text without issues: the green tick
await focus("hint-long");
expect((await dot.textContent()) === "✓" && (await dot.getAttribute("class")).includes("clean"), `G7: clean text should show a check mark, shows ${JSON.stringify(await dot.textContent())}`);
await shoot("G7-badge-clean", "hint-long");

// G8. Rich text: the caret is in the third paragraph; that paragraph's sentence is sent
await page.locator("#rich-mail p").nth(2).click({ position: { x: 5, y: 5 } });
await page.waitForTimeout(1800);
calls = improved.length;
expect(await openMenu(), "G8: no menu in the editor");
await menuItem("Improve this sentence").click();
await waitFor(".problem");
expect(improved.length === calls + 1 && improved.at(-1) === "See the release notes for the detials.", `G8: wrong sentence for the caret position: ${JSON.stringify(improved.slice(calls))}`);
await shootWithCard("G8-rich-from-menu", "rich-mail");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
// A double click selects the bold word; exactly it is sent.
await page.locator("#rich-mail b").first().dblclick();
await page.waitForTimeout(300);
calls = improved.length;
await openMenu();
expect((await menuLabels()).includes("Improve selection"), `G8: no selection item in the editor: ${JSON.stringify(await menuLabels())}`);
await menuItem("Improve selection").click();
await waitFor(".cost");
expect(improved.length === calls + 1 && improved.at(-1) === "attached", `G8: wrong selection sent from the editor: ${JSON.stringify(improved.slice(calls))}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// G9. Single-line input: a smaller badge straddling the bottom-right corner; one sentence, so one menu item
await focus("input-plain");
fieldBox = await boxOf("input-plain");
dotBox = await dot.boundingBox();
expect(Boolean(dotBox) && dotBox.width <= 16.5, `G9: the badge on a single-line input should be the small one: ${JSON.stringify(dotBox)}`);
expect(
  Boolean(dotBox) &&
    Math.abs(dotBox.x + dotBox.width / 2 - (fieldBox.x + fieldBox.width)) <= 3 &&
    Math.abs(dotBox.y + dotBox.height / 2 - (fieldBox.y + fieldBox.height)) <= 3,
  `G9: the badge should sit on the bottom-right corner: ${JSON.stringify(dotBox)} for ${JSON.stringify(fieldBox)}`,
);
await openMenu();
expect(same(await menuLabels(), ["Improve this sentence"]), `G9: wrong menu items in the input: ${JSON.stringify(await menuLabels())}`);
await shootWithMenu("G9-badge-input", "input-plain");
await page.keyboard.press("Escape");

// G10. A field in a scrollable panel: scrolled out of the panel, the badge must not float outside
await setScroll("scrollbox", { top: 60 });
await focus("inner");
await setScroll("scrollbox", { top: 110 });
await page.waitForTimeout(300);
expect(await dot.isVisible(), "G10: no badge for the textarea inside the panel");
await setScroll("scrollbox", { top: 0 });
await page.waitForTimeout(300);
const panelBox = await boxOf("scrollbox");
dotBox = (await dot.isVisible()) ? await dot.boundingBox() : null;
expect(!dotBox || dotBox.y + dotBox.height <= panelBox.y + panelBox.height, `G10: the badge floats outside the panel: ${JSON.stringify(dotBox)}`);
await shoot("G10-badge-panel-scrolled-away", "scrollbox", 4);

// G11. Lookup on the card, in both directions. Typing in the lookup box must not close the card.
await focus("plain");
await openMenu();
const termBox = page.locator("langfaix-badge .term");
const lookupEnglish = () => menu.locator(".copy.en").allTextContents();
const lookupChinese = () => menu.locator(".copy.zh").allTextContents();
expect(await termBox.isVisible(), "G11: the card has no lookup box");
const textBefore = await valueOf("plain");
await termBox.click();
await page.keyboard.insertText("归档中心");
await page.waitForTimeout(900); // far longer than the leave delay: the card must still be there
expect(await menu.isVisible() && (await dot.isVisible()), "G11: the card closed while typing in the lookup box");
expect(same(await lookupEnglish(), ["Archiving Center", "Archive Center"]), `G11: typing Chinese: ${JSON.stringify(await lookupEnglish())}`);
expect(same(await menu.locator(".applies").allTextContents(), ["Applies to: before 3.1.60", "Applies to: 3.1.60 and later"]), "G11: applies-to is not shown");
await shootWithMenu("G11-lookup-chinese", "plain");
await termBox.fill("center");
await page.waitForTimeout(700);
expect(same(await lookupEnglish(), ["Archiving Center", "Archive Center"]), `G11: typing English: ${JSON.stringify(await lookupEnglish())}`);
expect(same(await lookupChinese(), ["归档中心", "归档中心"]), "G11: typing English should show the Chinese too");
expect(same(lookups, ["归档中心", "center"]), `G11: wrong lookup requests: ${JSON.stringify(lookups)}`);
// Characters typed in the lookup box did not land in the field.
expect((await valueOf("plain")) === textBefore, "G11: typing in the lookup box changed the text box");
await menu.locator(".copy.en").nth(1).click();
await menu.locator(".copy.zh").first().click();
await page.waitForTimeout(200);
expect(same(copied, ["Archive Center", "归档中心"]), `G11: wrong text copied: ${JSON.stringify(copied)}`);
expect(await menu.isVisible(), "G11: the card closed after copying");
// Esc: the card closes and the caret returns to the field.
await termBox.press("Escape");
await page.waitForTimeout(400);
expect(!(await menu.isVisible()), "G11: Escape did not close the card");
expect((await focusedId()) === "plain", "G11: the cursor did not go back to the text box after Escape");
expect(await dot.isVisible(), "G11: the badge disappeared after the lookup");

// Clicking an AI rewrite while the caret is in the lookup box: the card closes, the AI card appears and stays.
calls = improved.length;
await openMenu();
await termBox.click();
await menuItem("Improve this sentence").click();
await waitFor(".diff");
await page.waitForTimeout(700);
expect(improved.length === calls + 1 && (await card.isVisible()), "G11: the AI card did not stay open when started while the cursor was in the lookup box");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// G12. The glossary switch on the card: the red lines follow at once, without typing
await focus("glossary");
const ruleMarks = async () => (await allMarks()).filter((item) => item.kind === "rule").map((item) => item.text);
expect(same(await ruleMarks(), ["策略", "Web UI"]), `G12: the glossary underlines are missing to begin with: ${JSON.stringify(await ruleMarks())}`);
await openMenu();
const glossarySwitch = menu.locator(".switch input");
expect(await glossarySwitch.isChecked(), "G12: the switch should show that the glossary is on");
await shootWithMenu("G12-switch-in-card", "glossary");
await glossarySwitch.uncheck();
await page.waitForTimeout(1500);
expect(glossaryOn === false, "G12: turning the switch off was not saved");
expect((await ruleMarks()).length === 0, `G12: the glossary underlines stayed after switching it off: ${JSON.stringify(await ruleMarks())}`);
expect(await menu.isVisible(), "G12: the card closed when the switch was used");
expect((await focusedId()) === "glossary", "G12: the text box lost the cursor when the switch was used");
await glossarySwitch.check();
await page.waitForTimeout(1500);
expect(glossaryOn === true && same(await ruleMarks(), ["策略", "Web UI"]), `G12: switching it back on did not bring the underlines back: ${JSON.stringify(await ruleMarks())}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
// Reopening the card: the switch remembers its state.
await openMenu();
expect(await menu.locator(".switch input").isChecked(), "G12: the switch forgot its state");

// G13. The switch is changed elsewhere (e.g. the options page): on returning to this page, tick and red lines follow
glossaryOn = false; // as if turned off on the options page
await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // as if returning from another tab
await page.waitForTimeout(1500);
expect(!(await menu.locator(".switch input").isChecked()), "G13: the open card still shows the glossary as on after it was switched off elsewhere");
expect((await ruleMarks()).length === 0, `G13: the underlines did not follow a switch made elsewhere: ${JSON.stringify(await ruleMarks())}`);
glossaryOn = true;
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(1500);
expect((await menu.locator(".switch input").isChecked()) && same(await ruleMarks(), ["策略", "Web UI"]), "G13: switching it back on elsewhere was not picked up");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ---------- T. Team glossary issues: wrong forms, and Chinese left in English text ----------

// T1. Both are underlined in the right place (Han characters are wider than Latin letters; the mirror's layout must match the field's)
await focus("glossary");
const termMarks = (await allMarks()).filter((item) => item.kind === "rule").map((item) => item.text);
expect(same(termMarks, ["策略", "Web UI"]), `T1: wrong underlines for the glossary box: ${JSON.stringify(termMarks)}`);
await shoot("T1-glossary-underlines", "glossary");

// T2. Stray Chinese: the card title is Terminology; the suggestion replaces the Chinese with the English
expect(await hoverWord("策略"), "T2: the Chinese term is not underlined");
await waitForCard();
expect((await cardText(".kind")) === "Terminology", `T2: wrong card title: ${JSON.stringify(await cardText(".kind"))}`);
expect((await cardText(".old")) === "策略", "T2: the card does not show the Chinese term");
expect((await cardText(".message")).includes("team glossary"), "T2: the card does not say where the suggestion comes from");
await shootWithCard("T2-chinese-term-card", "glossary");
await card.locator("button.suggestion", { hasText: "Policies" }).first().click();
await page.waitForTimeout(400);
expect((await valueOf("glossary")) === "Go to Policies and open the Web UI to continue.", `T2: the Chinese term was not replaced: ${JSON.stringify(await valueOf("glossary"))}`);
await page.waitForTimeout(1800);

// T3. A wrong form: replaced by the standard form
expect(await hoverWord("Web UI"), "T3: the wrong form is not underlined after the first fix");
await waitForCard();
await card.locator("button.suggestion", { hasText: "WebUI" }).first().click();
await page.waitForTimeout(400);
expect((await valueOf("glossary")) === "Go to Policies and open the WebUI to continue.", `T3: the wrong form was not replaced: ${JSON.stringify(await valueOf("glossary"))}`);
await page.waitForTimeout(600);

// ---------- W. Personal dictionary: Add to dictionary on the card ----------

// Reload the test page so every field has its initial content (dismissed words are cleared; the dictionary is not).
await page.reload();
await page.waitForTimeout(300);
const addWordButton = card.locator("button.add-word");

// W1. A spelling squiggle: the card has Add to dictionary. After the click the word's lines go at once and the badge count drops by one.
await focus("plain");
const countBefore = Number(await dot.textContent());
expect(await hoverWord("sentense"), "W1: sentense is not underlined to begin with");
await waitForCard();
expect((await addWordButton.textContent().catch(() => "")) === "Add to dictionary", "W1: a spelling card has no Add to dictionary button");
await shootWithCard("W1-add-to-dictionary", "plain");
await addWordButton.click();
await page.waitForTimeout(250);
expect(!(await card.isVisible()), "W1: the card stayed open after adding the word");
expect(!(await ruleMarks()).includes("sentense"), "W1: the underline stayed right after adding the word");
expect((await focusedId()) === "plain", "W1: the text box lost the cursor");
await page.waitForTimeout(2200); // wait for the re-check
expect(!(await ruleMarks()).includes("sentense"), "W1: the word came back after the next check");
expect((await ruleMarks()).includes("erors"), `W1: other spelling mistakes disappeared too: ${JSON.stringify(await ruleMarks())}`);
expect(Number(await dot.textContent()) === countBefore - 1, `W1: the badge should count one issue less (${countBefore} before, ${await dot.textContent()} now)`);
expect(same(dictionary.entries.map((entry) => entry.word), ["sentense"]), `W1: the dictionary should hold exactly this word: ${JSON.stringify(dictionary.entries)}`);
await shoot("W1-after-adding", "plain");

// W2. A grammar issue (This are) has no such button: "I know this word" does not solve it
expect((await hoverWord("This")) || (await hoverWord("are")) || (await hoverWord("This are")), "W2: the grammar mistake is not underlined");
await waitForCard();
expect((await cardText(".kind")) !== "" && (await addWordButton.count()) === 0, "W2: a grammar card should not offer Add to dictionary");
await page.mouse.move(5, 5);
await page.waitForTimeout(500);

// W3. An added word is not reported in other fields either (in the real extension: on all sites)
await focus("emoji");
expect((await ruleMarks()).length === 0, `W3: the word is still underlined in another box: ${JSON.stringify(await ruleMarks())}`);
// The dictionary has lower-case sentense, so the capitalised spelling is covered too.
await focus("nospell-prose");
await page.keyboard.press("Control+End");
await page.keyboard.type(" Sentense again.");
await page.waitForTimeout(2200);
expect((await ruleMarks()).length === 0, `W3: a capitalized form of a lower-case dictionary word is underlined: ${JSON.stringify(await ruleMarks())}`);

// W4. Team glossary issues have no such button either
await focus("glossary");
expect(await hoverWord("Web UI"), "W4: the wrong form is not underlined");
await waitForCard();
expect((await cardText(".kind")) === "Terminology" && (await addWordButton.count()) === 0, "W4: a terminology card should not offer Add to dictionary");
await page.mouse.move(5, 5);
await page.waitForTimeout(500);

// ---------- The caret leaves ----------

await page.locator("h1").click();
await page.waitForTimeout(900);
const overlayLeft = await page.evaluate(() => Boolean(document.querySelector("langfaix-overlay")));
const badgeLeft = await page.evaluate(() => Boolean(document.querySelector("langfaix-badge")));
expect(!badgeLeft, "the badge was left in the page after leaving");
const highlightsLeft = (await highlightCount()) + (await hintHighlightCount());
const spellcheckLeft = await page.evaluate(() =>
  [...document.querySelectorAll("textarea, input, [contenteditable]")]
    .filter((element) => !element.id.includes("nospell") && element.hasAttribute("spellcheck"))
    .map((element) => element.id),
);
expect(!overlayLeft, "the overlay was left in the page after leaving");
expect(highlightsLeft === 0, "highlights were left in the page after leaving");
expect(spellcheckLeft.length === 0, `spellcheck attribute was not restored on: ${spellcheckLeft.join(", ")}`);
expect(problems.length === 0, `page errors: ${problems.join(" | ")}`);

await browser.close();

console.log(`texts sent for checking : ${sent.length}`);
console.log(`texts sent to the fake AI: ${improved.length} (each one only after an AI button was clicked)`);
console.log(`screenshots             : ${SHOTS}`);
if (failures.length === 0) {
  console.log("RESULT: PASS (now look at the screenshots)");
} else {
  for (const failure of failures) console.log(`FAILED: ${failure}`);
  console.log("RESULT: FAIL");
}
process.exit(failures.length === 0 ? 0 : 1);
