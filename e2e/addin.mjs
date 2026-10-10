// Browser test of the Word add-in's pages: the task pane (taskpane.html) and the
// diagnostics page (spike.html).
//
// What it does:
//   1. unpacks the archive made by deploy/pack-backend.ps1 and starts the backend from the
//      unpacked folder as a plain process (not a container). So what is tested is exactly
//      what gets deployed: a file missing from the archive shows up here
//   2. starts a fake LanguageTool on this computer (it knows a few deliberate typos)
//   3. opens the add-in's pages in a headless browser, replaces Microsoft's office.js with
//      the fake Word in e2e/fake-office.js, presses every button and checks the log and
//      the lines in the fake document
//   4. checks that the backend really serves a file for every URL in the generated manifest
//
// What it cannot prove: whether real Word draws lines in the right place, the popup,
// events, speed. Those have to be tried in real Word.
//
// Usage (in the e2e folder, after running deploy/pack-backend.ps1):
//   npm run addin

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

const BACKEND = fileURLToPath(new URL("../backend/", import.meta.url));
const PYTHON = join(BACKEND, ".venv", "Scripts", "python.exe");
const BUILD = fileURLToPath(new URL("../deploy/build/", import.meta.url));
const FAKE_OFFICE = readFileSync(new URL("./fake-office.js", import.meta.url), "utf8");
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const TAR = join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- Unpack the archive that gets deployed ----------

const packed = join(BUILD, "langfaix-backend.tar");
if (!existsSync(packed)) {
  console.log(`FAILED: there is no ${packed}. Run deploy/pack-backend.ps1 first.`);
  console.log("RESULT: FAIL");
  process.exit(1);
}
const unpacked = mkdtempSync(join(tmpdir(), "langfaix-addin-"));
execFileSync(TAR, ["-xf", packed, "-C", unpacked]);
// Every file in the archive must equal the current code (catches a forgotten re-pack).
const sources = { "app/static/addin/word-addin/": "../word-addin/", "app/static/addin/browser-extension/lib/": "../browser-extension/lib/", "app/": "../backend/app/" };
const entries = execFileSync(TAR, ["-tf", packed], { encoding: "utf8" }).split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/"));
const outdated = entries.filter((entry) => {
  const prefix = Object.keys(sources).find((start) => entry.startsWith(start));
  if (!prefix) return false;
  const source = fileURLToPath(new URL(sources[prefix] + entry.slice(prefix.length), import.meta.url));
  return !existsSync(source) || !readFileSync(join(unpacked, entry)).equals(readFileSync(source));
});
expect(outdated.length === 0, `the package is not the same as the code now (run deploy/pack-backend.ps1 again): ${outdated.slice(0, 5).join(", ")}`);
expect(!entries.some((entry) => /addin\/.*(tests\/|package\.json|manifest\.template)/.test(entry)), "development-only add-in files are in the package");

// ---------- Fake LanguageTool and fake LiteLLM (one small server) ----------

// Knows these deliberate typos and answers in real LanguageTool format, with UTF-16 positions like the real one.
const TYPOS = { sentense: ["sentence", "sen tense"], erors: ["errors", "errs", "euros", "eros"], documant: ["document"], mistaek: ["mistake"], Zyphor: ["Zephyr"] };
const checked = []; // every text sent for a check
const checkedAs = []; // the language each check asked for
const improved = []; // every sentence sent to the "AI"
// The key the fake AI accepts. Any other gets 401, as from a real LiteLLM.
const GOOD_KEY = "sk-good";

// Split text into sentences in the shape of LanguageTool's sentenceRanges: [start, end] each.
function sentenceRangesOf(text) {
  const ranges = [];
  for (const found of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const lead = found[0].length - found[0].trimStart().length;
    const body = found[0].trim();
    if (body) ranges.push([found.index + lead, found.index + lead + body.length]);
  }
  return ranges;
}

// The fake AI: fixes the known typos and turns This are into These are. Answers in real LiteLLM format.
function fakeCompletion(sentence) {
  const edits = [];
  if (sentence.includes("This are")) edits.push({ original: "This are", replacement: "These are", reason: "The verb is plural, so the subject must be plural too." });
  for (const [typo, replacements] of Object.entries(TYPOS)) {
    if (sentence.includes(typo)) edits.push({ original: typo, replacement: replacements[0], reason: "Spelling." });
  }
  return {
    model: "langfAIx-model-1",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ edits }) } }],
    usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420, prompt_tokens_details: { cached_tokens: 0 } },
  };
}

const fake = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const reply = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    // ----- Fake LiteLLM -----
    if (request.url.startsWith("/key/info")) {
      // Term lookup needs an identity. No admin key is configured in this test, so the user's key looks itself up.
      if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) return reply(401, { error: { message: "Authentication Error", code: "401" } });
      return reply(200, { key: "...", info: { key_alias: "tester", status: "active", blocked: null } });
    }
    if (request.url.startsWith("/v1/model/info")) {
      // Prices per million tokens: input 0.40 USD, output 1.60 USD.
      const info = { input_cost_per_token: 0.4e-6, output_cost_per_token: 1.6e-6, cache_read_input_token_cost: 0.1e-6, litellm_provider: "openai" };
      return reply(200, { data: [{ model_name: "langfAIx-model-1", litellm_params: { model: "openai/some-model" }, model_info: info }] });
    }
    if (request.url.startsWith("/v1/chat/completions")) {
      if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) {
        return reply(401, { error: { message: "Authentication Error, Invalid proxy server token passed.", type: "token_not_found_in_db", code: "401" } });
      }
      const sentence = JSON.parse(body).messages.at(-1).content;
      improved.push(sentence);
      return reply(200, fakeCompletion(sentence));
    }
    // ----- Fake LanguageTool -----
    if (!request.url.startsWith("/v2/check")) return reply(404, { error: "not found" });
    const text = new URLSearchParams(body).get("text") ?? "";
    checked.push(text);
    checkedAs.push(new URLSearchParams(body).get("language") ?? "");
    const matches = [];
    for (const [typo, replacements] of Object.entries(TYPOS)) {
      for (let offset = text.indexOf(typo); offset !== -1; offset = text.indexOf(typo, offset + 1)) {
        matches.push({
          message: "Possible spelling mistake found.",
          shortMessage: "Spelling mistake",
          replacements: replacements.map((value) => ({ value })),
          offset,
          length: typo.length,
          rule: { id: "MORFOLOGIK_RULE_EN_US", description: "Possible spelling mistake", issueType: "misspelling", category: { id: "TYPOS", name: "Possible Typo" } },
        });
      }
    }
    // One grammar issue, to confirm that Add to dictionary only appears on spelling cards.
    for (let offset = text.indexOf("He go "); offset !== -1; offset = text.indexOf("He go ", offset + 1)) {
      matches.push({
        message: "The verb does not agree with the subject.",
        shortMessage: "Grammar",
        replacements: [{ value: "He goes" }],
        offset,
        length: 5,
        rule: { id: "HE_VERB_AGR", description: "Agreement", issueType: "grammar", category: { id: "GRAMMAR", name: "Grammar" } },
      });
    }
    matches.sort((a, b) => a.offset - b.offset);
    reply(200, { language: { code: "en-US" }, matches, sentenceRanges: sentenceRangesOf(text) });
  });
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const fakePort = await listen(fake);
const probe = createServer();
const port = await listen(probe);
await new Promise((resolve) => probe.close(resolve));

// ---------- Start the backend (from the unpacked archive) ----------

const backend = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: unpacked,
  env: { ...process.env, LANGUAGETOOL_URL: `http://127.0.0.1:${fakePort}`, LITELLM_URL: `http://127.0.0.1:${fakePort}`, ROOT_PATH: "/api", DATABASE_URL: "", GLOSSARY_ADMINS: "tester" },
  stdio: ["ignore", "pipe", "pipe"],
});
let backendLog = "";
backend.stdout.on("data", (chunk) => (backendLog += chunk));
backend.stderr.on("data", (chunk) => (backendLog += chunk));

const BASE = `http://127.0.0.1:${port}`;
async function waitForBackend() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the backend did not start:\n${backendLog}`);
}

// The fake document: three pages, with an emoji (two positions), an empty paragraph and one typo twice.
const DOCUMENT = [
  ["Release notes", "", "This sentense has a mistaek. Great news 😀🎉 but one more sentense here."],
  ["The second page is fine.", "Please read the documant before friday."],
  ["Nothing wrong on the third page."],
];

let browser;
try {
  await waitForBackend();

  // ---------- The backend serves a file for every URL in the manifest ----------
  const manifestPath = join(BUILD, "langfaix-word-manifest.xml");
  if (!existsSync(manifestPath)) {
    failures.push(`there is no ${manifestPath}. Run deploy/pack-word-addin.ps1 first.`);
  } else {
    const manifest = readFileSync(manifestPath, "utf8");
    expect(!manifest.includes("{{"), "the manifest still has a {{...}} mark that was not filled in");
    const urls = [...new Set([...manifest.matchAll(/DefaultValue="(https:\/\/[^"]+)"/g)].map((found) => found[1]))];
    expect(urls.length >= 5, `the manifest names only ${urls.length} addresses`);
    for (const url of urls) {
      // What follows /api in the URL is the path the backend itself sees (the reverse proxy strips /api).
      const path = new URL(url).pathname.replace(/^\/api/, "");
      const response = await fetch(`${BASE}${path}`);
      expect(response.ok, `the manifest points to ${url}, but the backend answers HTTP ${response.status} for ${path}`);
    }
  }

  // ---------- Open the page ----------
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  // The page loads office.js from Microsoft's servers. The test substitutes the fake Word.
  await page.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  // A headless browser has no usable clipboard: a stand-in records the text.
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => window.__copied.push(text) } });
  });

  await page.goto(`${BASE}/addin/word-addin/spike.html`);
  await page.waitForFunction(() => document.querySelector("#log").value.includes("event handlers registered"), null, { timeout: 8000 });
  await page.evaluate((pages) => window.__fakeWord.setDocument(pages), DOCUMENT);

  const logText = () => page.inputValue("#log");
  const underlines = () => page.evaluate(() => window.__fakeWord.underlines());
  // Press a button and wait for its "done" line in the log.
  async function press(id, title) {
    const before = (await logText()).split(`(${title}:`).length;
    await page.click(`#${id}`);
    await page.waitForFunction(([name, count]) => document.querySelector("#log").value.split(`(${name}:`).length > count, [title, before], { timeout: 10000 });
  }
  const lastSection = async (title) => (await logText()).split(`=== ${title} ===`).at(-1);

  // 1. Environment: Word is recognised and the backend is reachable
  await press("environment", "Environment");
  let section = await lastSection("Environment");
  expect(section.includes("host: Word"), "1: the page did not report the host");
  expect(section.includes('server: HTTP 200 {"status":"ok"'), `1: the page could not reach the backend through its relative address: ${section}`);
  expect(section.includes("localStorage: works"), "1: localStorage was not tested");

  // 2. One paragraph: the cursor is in the third (after an empty one; it contains an emoji)
  await page.evaluate(() => window.__fakeWord.moveCursorTo(2));
  await press("check-paragraph", "Check this paragraph");
  section = await lastSection("Check this paragraph");
  let marks = await underlines();
  expect(same(marks.map((mark) => mark.text), ["sentense", "mistaek", "sentense"]), `2: wrong words underlined: ${JSON.stringify(marks.map((mark) => mark.text))}`);
  expect(marks.every((mark) => mark.paragraph === 2 && mark.colour === "Red"), "2: the underlines are in the wrong paragraph or colour");
  expect(same(marks[0].suggestions, ["sentence", "sen tense"]) && marks[0].popupTitle === "Popup.Title", `2: wrong popup: ${JSON.stringify(marks[0])}`);
  expect(section.includes("POSITIONS: all correct"), `2: the page did not confirm the positions: ${section}`);
  expect(same(checked.at(-1), DOCUMENT[0][2]), "2: the wrong text was sent for checking");
  // Pressing again deletes the old lines first: no word gets two.
  await press("check-paragraph", "Check this paragraph");
  expect((await underlines()).length === 3, `2: checking twice doubled the underlines: ${(await underlines()).length}`);

  // With more than 3 suggestions only the first 3 go to Word (its popup shows 3).
  await page.evaluate(() => window.__fakeWord.setDocument([["Two erors."]]));
  await page.evaluate(() => window.__fakeWord.moveCursorTo(0));
  await press("check-paragraph", "Check this paragraph");
  marks = await underlines();
  expect(same(marks[0]?.suggestions, ["errors", "errs", "euros"]), `2: more than 3 suggestions were passed to Word: ${JSON.stringify(marks[0]?.suggestions)}`);

  // A suggestion is clicked in the popup. Checkbox off: the page only logs the event. On: the page replaces the text.
  await page.evaluate((id) => window.__fakeWord.acceptSuggestion(id, "errors"), marks[0].id);
  await page.waitForFunction(() => document.querySelector("#log").value.includes("EVENT popup action: Accept"), null, { timeout: 3000 }).catch(() => {});
  expect((await logText()).includes('EVENT popup action: Accept, suggestion "errors"'), "2: the popup action was not logged");
  expect(same(await page.evaluate(() => window.__fakeWord.paragraphs()), ["Two erors."]), "2: the text was replaced although the box was off");
  await page.check("#replace-myself");
  await page.evaluate((id) => window.__fakeWord.acceptSuggestion(id, "errors"), marks[0].id);
  await page.waitForFunction(() => document.querySelector("#log").value.includes("the add-in replaced the text"), null, { timeout: 3000 }).catch(() => {});
  expect(same(await page.evaluate(() => window.__fakeWord.paragraphs()), ["Two errors."]), `2: the add-in did not replace the text: ${JSON.stringify(await page.evaluate(() => window.__fakeWord.paragraphs()))}`);

  // If Word draws a line in the wrong place the page must detect it (the reason this page exists).
  await page.evaluate(() => {
    window.__fakeWord.setDocument([["This sentense is shifted."]]);
    window.__fakeWord.setShift(2);
  });
  await press("check-paragraph", "Check this paragraph");
  section = await lastSection("Check this paragraph");
  expect(section.includes("WRONG") && section.includes("POSITIONS: 1 of 1 are WRONG"), `2: a shifted underline was not reported as wrong: ${section}`);
  await page.evaluate(() => window.__fakeWord.setShift(0));

  // 3. Two colours
  await page.evaluate(() => window.__fakeWord.setDocument([["One two three four five six seven."]]));
  await press("two-colours", "Two colours");
  marks = await underlines();
  expect(same(marks.map((mark) => [mark.colour, mark.text]), [["Lavender", "One two three four five six seven."], ["Red", "two"]]), `3: wrong underlines: ${JSON.stringify(marks)}`);

  // 4. Watching the pages on screen
  await page.evaluate((pages) => {
    window.__fakeWord.setDocument(pages);
    window.__fakeWord.setVisiblePages([1]);
  }, DOCUMENT);
  await page.click("#watch-pages");
  await page.waitForFunction(() => document.querySelector("#log").value.includes("pages on screen: 1 "), null, { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => window.__fakeWord.setVisiblePages([2, 3]));
  await page.waitForFunction(() => document.querySelector("#log").value.includes("pages on screen: 2,3 "), null, { timeout: 4000 }).catch(() => {});
  section = await lastSection("Watching pages (asking every 700 ms)");
  expect(section.includes("pages on screen: 1 ") && section.includes("pages on screen: 2,3 "), `4: page changes were not logged: ${section}`);
  // No repeated log line while the pages stay the same.
  await page.waitForTimeout(1600);
  expect((await lastSection("Watching pages (asking every 700 ms)")).split("pages on screen:").length === 3, "4: the same pages were logged again although nothing changed");
  expect((await page.textContent("#watch-pages")) === "Stop watching pages", "4: the button does not show that it is watching");
  await page.click("#watch-pages");
  expect((await logText()).includes("stopped. Asked "), "4: no timing summary after stopping");

  // Both pages on screen are checked together: one request, lines on the right paragraphs at the right positions.
  const requestsBefore = checked.length;
  await press("check-visible", "Check visible pages");
  section = await lastSection("Check visible pages");
  marks = await underlines();
  expect(checked.length === requestsBefore + 1, `4: ${checked.length - requestsBefore} requests were sent for one screen, expected 1`);
  expect(checked.at(-1) === "The second page is fine.\n\nPlease read the documant before friday.\n\nNothing wrong on the third page.", `4: wrong text sent: ${JSON.stringify(checked.at(-1))}`);
  expect(same(marks.map((mark) => [mark.paragraph, mark.text]), [[4, "documant"]]), `4: wrong underlines: ${JSON.stringify(marks)}`);
  expect(section.includes("POSITIONS: all 1 correct"), `4: the positions were not confirmed: ${section}`);
  // Page 1: an empty paragraph, an emoji, three errors.
  await page.evaluate(() => window.__fakeWord.setVisiblePages([1]));
  await press("check-visible", "Check visible pages");
  marks = await underlines();
  expect(
    same(marks.map((mark) => [mark.paragraph, mark.text]), [[4, "documant"], [2, "sentense"], [2, "mistaek"], [2, "sentense"]]),
    `4: wrong underlines after checking the first page too: ${JSON.stringify(marks.map((mark) => [mark.paragraph, mark.text]))}`,
  );
  expect((await lastSection("Check visible pages")).includes("POSITIONS: all 3 correct"), "4: positions on the first page were not confirmed");
  await page.screenshot({ path: join(SHOTS, "addin-spike.png"), fullPage: true });

  // 5. Clean up: every line this page drew is deleted
  await press("clear", "Clear all underlines");
  expect((await underlines()).length === 0, `5: underlines were left: ${JSON.stringify(await underlines())}`);

  // Copy the log.
  await page.click("#copy-log");
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => window.__copied);
  expect(copied.length === 1 && copied[0] === (await logText()), "the log was not copied");
  expect((await page.textContent("#copy-status")) === "Copied.", "no confirmation after copying");

  expect(!(await logText()).includes("ERROR:"), `the log contains an error: ${(await logText()).split("\n").filter((line) => line.includes("ERROR:")).join(" | ")}`);
  expect(problems.length === 0, `page errors: ${problems.join(" | ")}`);
  await page.close();

  // ====================== The task pane: automatic checking that follows the scrolling ======================

  // A five-page fake document. Page 1 has one typo twice, an emoji and an empty paragraph.
  const PAGES = [
    ["Release notes", "", "This sentense has a mistaek. Great news 😀🎉 but one more sentense here."],
    ["The second page is fine.", "Please read the documant before friday."],
    ["Nothing wrong on the third page."],
    ["A mistaek on page four."],
    ["Page five has erors too."],
  ];
  const pane = await context.newPage();
  const paneProblems = [];
  pane.on("pageerror", (error) => paneProblems.push(String(error)));
  await pane.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  // The fake document must be ready before the page's script starts working.
  await pane.addInitScript((pages) => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__fakeWord.setDocument(pages);
      window.__fakeWord.setVisiblePages([1]);
    });
  }, PAGES);
  await pane.goto(`${BASE}/addin/word-addin/taskpane.html`);

  const status = async () => ((await pane.textContent("#status")) ?? "").trim();
  const where = async () => ((await pane.textContent("#where")) ?? "").trim();
  const waitStatus = (text, timeout = 6000) =>
    pane.waitForFunction((wanted) => document.querySelector("#status").textContent.trim() === wanted, text, { timeout }).catch(() => {});
  const listed = () => pane.locator("#issues .issue .old").allTextContents();
  // The red lines (rule issues) in the document. Lavender hint lines are not included; they are tested separately.
  const drawn = () => pane.evaluate(() => window.__fakeWord.underlines().filter((mark) => mark.colour === "Red"));
  const word = (name, ...args) => pane.evaluate(([method, values]) => window.__fakeWord[method](...values), [name, args]);
  const idOf = async (text, nth = 0) => (await drawn()).filter((mark) => mark.text === text)[nth]?.id;

  // S0. Term lookup without a key: the reason is given with a button to the settings, not silence
  await pane.waitForFunction(() => !document.querySelector("#term").disabled, null, { timeout: 5000 }).catch(() => {});
  await pane.fill("#term", "center");
  await pane.locator("#lookup .problem").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(((await pane.textContent("#lookup .problem").catch(() => "")) ?? "") === "The API key is not set. Enter it under Settings.", "S0: looking up a term without a key should say why");
  expect((await pane.locator("#lookup button.accept", { hasText: "Open Settings" }).count()) === 1, "S0: no button to open the settings");
  await pane.fill("#term", "");
  await pane.locator("#lookup").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});

  // S1. Starts by itself on opening: page 1 is checked, lines are drawn, its three issues are listed
  checked.length = 0;
  await waitStatus("3 issues on screen");
  expect((await status()) === "3 issues on screen", `S1: wrong status: "${await status()}"`);
  expect((await where()) === "Page 1", `S1: wrong page label: "${await where()}"`);
  expect(same(await listed(), ["sentense", "mistaek", "sentense"]), `S1: wrong list: ${JSON.stringify(await listed())}`);
  expect(same((await drawn()).map((mark) => [mark.paragraph, mark.text, mark.colour]), [[2, "sentense", "Red"], [2, "mistaek", "Red"], [2, "sentense", "Red"]]), `S1: wrong underlines: ${JSON.stringify(await drawn())}`);
  expect(same(checked, [`Release notes\n\n${PAGES[0][2]}`]), `S1: one request for the page was expected, got ${JSON.stringify(checked)}`);
  const firstCard = pane.locator("#issues .issue:not(.hint)").first();
  expect((await firstCard.locator(".kind").textContent()) === "Spelling", "S1: the card does not say what kind of issue it is");
  expect(same(await firstCard.locator("button.suggest").allTextContents(), ["sentence", "sen tense"]), `S1: suggestions on the card: ${JSON.stringify(await firstCard.locator("button.suggest").allTextContents())}`);
  expect(((await firstCard.locator(".message").textContent()) ?? "").includes("spelling"), "S1: the card has no explanation");
  await pane.screenshot({ path: join(SHOTS, "addin-pane-page1.png") });

  // S2. Scrolled to pages 2 and 3: only the new paragraphs are checked and the list shows those pages; page 1's lines stay in the document
  await word("setVisiblePages", [2, 3]);
  await waitStatus("1 issue on screen");
  expect((await where()) === "Pages 2 to 3", `S2: wrong page label: "${await where()}"`);
  expect(same(await listed(), ["documant"]), `S2: wrong list: ${JSON.stringify(await listed())}`);
  expect(checked.length === 2 && checked[1] === "The second page is fine.\n\nPlease read the documant before friday.\n\nNothing wrong on the third page.", `S2: wrong request: ${JSON.stringify(checked.slice(1))}`);
  expect((await drawn()).length === 4, `S2: the underlines of page 1 should stay in the document: ${(await drawn()).length} underlines`);

  // S3. Scrolled back to page 1: nothing is checked again and the list switches back at once
  await word("setVisiblePages", [1]);
  await waitStatus("3 issues on screen");
  await pane.waitForTimeout(1600);
  expect(checked.length === 2, `S3: scrolling back sent the page again (${checked.length} requests)`);
  expect(same(await listed(), ["sentense", "mistaek", "sentense"]), "S3: the list did not switch back");

  // S4. Clicking a list item jumps to it in the document
  await pane.locator("#issues .issue:not(.hint)", { hasText: "mistaek" }).click();
  await pane.waitForTimeout(200);
  expect((await word("selected")) === "mistaek", `S4: the document did not jump to the issue: selected ${JSON.stringify(await word("selected"))}`);

  // S5. Pointing at a line in the document lights up its card
  await word("userHovers", await idOf("mistaek"));
  await pane.waitForTimeout(200);
  expect(same(await pane.locator("#issues .issue.current .old").allTextContents(), ["mistaek"]), "S5: hovering an underline did not highlight its card");

  // S6. Ignore in Word's popup: the issue is not drawn again and the same word elsewhere goes too
  await word("userIgnores", await idOf("sentense", 0));
  await waitStatus("1 issue on screen");
  expect(same(await listed(), ["mistaek"]), `S6: wrong list after ignoring: ${JSON.stringify(await listed())}`);
  expect(same((await drawn()).filter((mark) => mark.paragraph === 2).map((mark) => mark.text), ["mistaek"]), `S6: the other underline of the ignored word is still drawn: ${JSON.stringify(await drawn())}`);

  // S7. The user types on: after a pause only that paragraph is re-checked; the ignored word stays away, a new typo is underlined
  const before = checked.length;
  await word("userTypes", 2, `${PAGES[0][2]} More erors.`);
  await waitStatus("2 issues on screen");
  expect(same(await listed(), ["mistaek", "erors"]), `S7: wrong list after typing: ${JSON.stringify(await listed())}`);
  expect(checked.length === before + 1 && checked.at(-1) === `${PAGES[0][2]} More erors.`, `S7: only the changed paragraph should be sent: ${JSON.stringify(checked.slice(before))}`);
  expect(same((await drawn()).filter((mark) => mark.paragraph === 2).map((mark) => mark.text), ["mistaek", "erors"]), `S7: wrong underlines after the re-check: ${JSON.stringify(await drawn())}`);

  // No check while typing (the text keeps changing).
  const whileTyping = checked.length;
  for (const extra of [" A", " An", " And"]) {
    await word("userTypes", 2, `${PAGES[0][2]} More erors.${extra}`);
    await pane.waitForTimeout(350);
  }
  expect(checked.length === whileTyping, `S7: a check was sent while the text was still changing (${checked.length - whileTyping})`);
  await pane.waitForTimeout(1900);
  expect(checked.length === whileTyping + 1, `S7: after the typing stopped exactly one check was expected, got ${checked.length - whileTyping}`);

  // S8. A suggestion clicked in Word's popup: Word replaces the text itself; the add-in only re-checks
  await word("userAccepts", await idOf("mistaek"), "mistake");
  await waitStatus("1 issue on screen");
  expect(same(await listed(), ["erors"]), `S8: wrong list after accepting: ${JSON.stringify(await listed())}`);
  const page1Text = (await word("paragraphs"))[2];
  expect(page1Text.includes("has a mistake.") && !page1Text.includes("mistakeke") && page1Text.split("mistake").length === 2, `S8: the text was changed more than once: ${JSON.stringify(page1Text)}`);
  expect(same((await drawn()).filter((mark) => mark.paragraph === 2).map((mark) => mark.text), ["erors"]), `S8: wrong underlines after accepting: ${JSON.stringify(await drawn())}`);

  // S9. Server unreachable: the reason is given and it retries by itself after a while
  await pane.route("**/check", (route) => route.abort());
  await word("setVisiblePages", [4]);
  await pane.waitForFunction(() => document.querySelector("#status").textContent.includes("Cannot reach the server"), null, { timeout: 5000 }).catch(() => {});
  expect((await status()).startsWith("Cannot reach the server"), `S9: wrong message when the server cannot be reached: "${await status()}"`);
  expect(await pane.locator("#status.error").count() === 1, "S9: the message should be shown as an error");
  await pane.unroute("**/check");
  await waitStatus("1 issue on screen", 9000);
  expect(same(await listed(), ["mistaek"]), `S9: the add-in did not recover after the server came back: "${await status()}" ${JSON.stringify(await listed())}`);

  // S10. Pause: a newly scrolled page is not checked until Resume
  await pane.click("#pause");
  expect((await status()) === "Paused" && (await pane.textContent("#pause")) === "Resume", `S10: wrong state after Pause: "${await status()}"`);
  const paused = checked.length;
  await word("setVisiblePages", [5]);
  await pane.waitForTimeout(1700);
  expect(checked.length === paused, "S10: a page was sent for checking while paused");
  // Pause only stops checking. The list still follows the scrolling: on the unchecked page 5 it is empty.
  expect((await where()) === "Page 5" && (await listed()).length === 0 && (await status()) === "Paused", `S10: while paused the list should still follow the scrolling: "${await where()}" ${JSON.stringify(await listed())}`);
  // Back on the checked page 4: the issue found earlier is still listed.
  await word("setVisiblePages", [4]);
  await pane.waitForFunction(() => document.querySelector("#where").textContent === "Page 4", null, { timeout: 3000 }).catch(() => {});
  expect(same(await listed(), ["mistaek"]), `S10: while paused, a page checked earlier should still list its issues: ${JSON.stringify(await listed())}`);
  await word("setVisiblePages", [5]);
  await pane.waitForFunction(() => document.querySelector("#where").textContent === "Page 5", null, { timeout: 3000 }).catch(() => {});
  await pane.click("#pause");
  await waitStatus("1 issue on screen");
  expect(same(await listed(), ["erors"]) && (await where()) === "Page 5", `S10: wrong list after Resume: ${JSON.stringify(await listed())} on "${await where()}"`);
  expect(checked.at(-1) === "Page five has erors too.", "S10: the page was not checked after Resume");

  // S11. A page without issues
  await word("setVisiblePages", [3]);
  await waitStatus("No issues on screen");
  expect(await pane.locator("#empty").isVisible(), "S11: a page without issues should say so");
  await pane.screenshot({ path: join(SHOTS, "addin-pane-clean.png") });

  expect((await pane.getAttribute(".foot a", "href")) === "spike.html", "the link to the diagnostics page is missing");
  expect(paneProblems.length === 0, `page errors in the pane: ${paneProblems.join(" | ")}`);
  await pane.close();

  // ====================== The task pane: AI rewriting ======================

  const AI_PAGES = [
    ["Intro line.", "This are a test sentense. It have two more erors here. The last one is fine."],
    ["Second page with the documant."],
  ];
  const ai = await context.newPage();
  const aiProblems = [];
  ai.on("pageerror", (error) => aiProblems.push(String(error)));
  await ai.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  await ai.addInitScript((pages) => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__fakeWord.setDocument(pages);
      window.__fakeWord.setVisiblePages([1]);
    });
  }, AI_PAGES);
  await ai.goto(`${BASE}/addin/word-addin/taskpane.html`);
  const aiWord = (name, ...args) => ai.evaluate(([method, values]) => window.__fakeWord[method](...values), [name, args]);
  const aiCard = ai.locator("#ai");
  const aiTexts = (selector) => aiCard.locator(selector).allTextContents();
  const aiText = async (selector) => ((await aiCard.locator(selector).first().textContent().catch(() => "")) ?? "").trim();
  const optionLabels = () => aiCard.locator("button.option .label").allTextContents();
  const pick = (label) => aiCard.locator("button.option", { hasText: label }).click();
  const waitAi = (selector) => aiCard.locator(selector).first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const paragraphs = () => aiWord("paragraphs");
  const openMenu = async () => {
    await ai.click("#ai-open");
    await aiCard.locator("button.option, .note, .problem").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  };
  await ai.waitForFunction(() => document.querySelector("#status").textContent.trim() === "2 issues on screen", null, { timeout: 6000 }).catch(() => {});

  // A1. The most important check: automatic checking drew lines and listed issues, but no text has gone to the AI
  expect(improved.length === 0, `A1: text was sent to the AI before anything was clicked: ${JSON.stringify(improved)}`);
  expect(await aiCard.isHidden(), "A1: the AI area should be closed to begin with");

  // A2. Cursor in the second sentence, Improve with AI clicked: the ranges are listed and still nothing is sent
  await aiWord("putCursorIn", 1, "erors");
  await openMenu();
  expect(same(await optionLabels(), ["Improve this sentence", "Improve this paragraph"]), `A2: wrong options: ${JSON.stringify(await optionLabels())}`);
  expect((await aiText("button.option .detail")).includes("It have two more erors here."), `A2: the option does not show which sentence it means: "${await aiText("button.option .detail")}"`);
  expect(improved.length === 0, "A2: opening the menu sent text to the AI");
  await ai.screenshot({ path: join(SHOTS, "addin-ai-menu.png") });

  // A3. No key: the reason is given with a button to the settings
  await pick("Improve this sentence");
  await waitAi(".problem");
  expect((await aiText(".problem")) === "The API key is not set. Enter it under Settings.", `A3: wrong message without a key: "${await aiText(".problem")}"`);
  expect(improved.length === 0, "A3: text reached the AI without a key");
  await aiCard.locator("button.accept", { hasText: "Open Settings" }).click();
  expect(await ai.locator("#settings").isVisible(), "A3: Open Settings did not open the settings");

  // A4. A wrong key: one understandable sentence instead of LiteLLM's error dump
  await ai.fill("#api-key", "sk-wrong");
  await ai.click("#save-key");
  await openMenu();
  await pick("Improve this sentence");
  await waitAi(".problem");
  expect((await aiText(".problem")).startsWith("The API key was rejected. Check it under Settings"), `A4: wrong message for a rejected key: "${await aiText(".problem")}"`);
  expect(improved.length === 0, "A4: the fake AI accepted a wrong key");

  // A5. The right key: only that sentence is sent; deletions, additions, reasons, cost and model are shown
  await ai.fill("#api-key", ` ${GOOD_KEY} `);
  await ai.click("#save-key");
  expect((await ai.evaluate(() => localStorage.getItem("langfaix:apiKey"))) === JSON.stringify(GOOD_KEY), "A5: the key was not stored (trimmed) on this computer");
  await ai.click("#settings-close");
  await openMenu();
  await pick("Improve this sentence");
  await waitAi(".diff");
  expect(same(improved, ["It have two more erors here."]), `A5: only the one sentence should be sent: ${JSON.stringify(improved)}`);
  expect(same(await aiTexts(".removed"), ["erors"]) && same(await aiTexts(".added"), ["errors"]), `A5: wrong diff: ${JSON.stringify([await aiTexts(".removed"), await aiTexts(".added")])}`);
  expect(same(await aiTexts(".reasons li"), ["Spelling."]), "A5: the reason is not shown");
  expect((await aiText(".cost")) === "420 tokens (in 400 / out 20) · US$0.0002", `A5: wrong cost line: "${await aiText(".cost")}"`);
  expect((await aiText(".model")) === "Model: langfAIx-model-1", `A5: wrong model line: "${await aiText(".model")}"`);
  expect((await paragraphs())[1] === AI_PAGES[0][1], "A5: the document was changed before Accept");
  await ai.screenshot({ path: join(SHOTS, "addin-ai-result.png") });

  // A6. Accept: only that place is replaced, nothing else changes
  await aiCard.locator("button.accept", { hasText: "Accept" }).click();
  await waitAi(".note");
  expect((await paragraphs())[1] === "This are a test sentense. It have two more errors here. The last one is fine.", `A6: wrong text after Accept: ${JSON.stringify((await paragraphs())[1])}`);
  expect((await aiText(".note")) === "1 change applied.", `A6: wrong confirmation: "${await aiText(".note")}"`);
  // The text changed, so the paragraph is re-checked automatically: erors leaves the list.
  await ai.waitForFunction(() => document.querySelector("#status").textContent.trim() === "1 issue on screen", null, { timeout: 6000 }).catch(() => {});
  expect(same(await ai.locator("#issues .issue .old").allTextContents(), ["sentense"]), "A6: the list was not updated after the change");

  // A7. The first sentence has two edits. Declined, then asked again: the earlier result is reused, nothing is sent, and it says not charged again
  await aiWord("putCursorIn", 1, "test");
  await openMenu();
  await pick("Improve this sentence");
  await waitAi(".diff");
  expect(same(await aiTexts(".removed"), ["This are", "sentense"]) && same(await aiTexts(".added"), ["These are", "sentence"]), `A7: wrong diff for two edits: ${JSON.stringify(await aiTexts(".removed"))}`);
  const sentBefore = improved.length;
  await aiCard.locator("button.link", { hasText: "Dismiss" }).click();
  expect(await aiCard.isHidden(), "A7: Dismiss did not close the AI area");
  await openMenu();
  await pick("Improve this sentence");
  await waitAi(".diff");
  expect(improved.length === sentBefore, "A7: the same sentence was sent (and charged) twice");
  expect((await aiTexts(".note")).includes("Checked earlier. Not charged again."), "A7: the card does not say that this was not charged again");
  await aiCard.locator("button.accept", { hasText: "Accept" }).click();
  await waitAi(".note");
  expect((await paragraphs())[1] === "These are a test sentence. It have two more errors here. The last one is fine.", `A7: wrong text after accepting two edits: ${JSON.stringify((await paragraphs())[1])}`);
  expect((await aiText(".note")) === "2 changes applied.", `A7: wrong confirmation: "${await aiText(".note")}"`);

  // A8. With a selection there is an Improve selection item, and exactly the selection is sent. The AI finds nothing to change: no Accept, but the cost is shown
  await aiWord("selectText", 1, "The last one is fine.");
  await openMenu();
  expect(same(await optionLabels(), ["Improve this sentence", "Improve selection", "Improve this paragraph"]), `A8: wrong options with a selection: ${JSON.stringify(await optionLabels())}`);
  await pick("Improve selection");
  await waitAi(".cost");
  expect(improved.at(-1) === "The last one is fine.", `A8: wrong text sent for the selection: ${JSON.stringify(improved.at(-1))}`);
  expect((await aiText(".cost")).startsWith("AI checked, no change needed"), `A8: wrong line when nothing needs changing: "${await aiText(".cost")}"`);
  expect((await aiCard.locator("button.accept").count()) === 0, "A8: Accept is offered although there is nothing to accept");

  // A9. The whole paragraph: three sentences, a section each, a total at the bottom
  await aiWord("putCursorIn", 1, "test");
  await openMenu();
  await pick("Improve this paragraph");
  await waitAi(".cost.total");
  expect((await aiCard.locator(".section").count()) === 3, `A9: three sentences should give three sections, got ${await aiCard.locator(".section").count()}`);
  expect((await aiText(".cost.total")).startsWith("Total for 3 sentences · "), `A9: wrong total line: "${await aiText(".cost.total")}"`);
  expect(same(await aiTexts(".model"), ["Model: langfAIx-model-1"]), "A9: the model should be named once");
  await aiCard.locator("button.link", { hasText: "Close" }).first().click();

  // A10. A selection across two paragraphs: one Improve selection item stating the number of paragraphs. Nothing is sent while it is listed
  const beforeAcross = improved.length;
  await aiWord("selectAcross", 0);
  await openMenu();
  expect(same(await optionLabels(), ["Improve selection"]) && (await aiText("button.option .detail")).startsWith("2 paragraphs"), `A10: wrong options for a selection across paragraphs: ${JSON.stringify(await optionLabels())} "${await aiText("button.option .detail")}"`);
  expect(improved.length === beforeAcross, "A10: listing the options sent text to the AI");
  await aiCard.locator("button.link", { hasText: "Close" }).first().click();

  // A11. Improve sentence with AI on an issue card: rewrites the sentence the issue is in
  await aiWord("setVisiblePages", [2]);
  await ai.locator("#issues .issue", { hasText: "documant" }).waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  await ai.locator("#issues .issue", { hasText: "documant" }).locator("button.ai-link").click();
  await waitAi(".diff");
  expect(improved.at(-1) === "Second page with the documant.", `A11: wrong sentence sent from the issue card: ${JSON.stringify(improved.at(-1))}`);
  expect((await aiWord("selected")) === null, "A11: clicking the AI link also jumped to the issue");

  // A12. The user fixed that place while waiting: Accept changes nothing wrongly and reports one edit not applied
  await aiWord("userTypes", 2, "Second page with the paper.");
  await aiCard.locator("button.accept", { hasText: "Accept" }).click();
  await waitAi(".problem");
  expect((await paragraphs())[2] === "Second page with the paper.", `A12: the text was changed although it no longer matched: ${JSON.stringify((await paragraphs())[2])}`);
  expect((await aiText(".problem")) === "0 changes applied. 1 could not be applied because the text there has changed.", `A12: wrong message: "${await aiText(".problem")}"`);

  // A13. The glossary switch in the settings: saved at once, and the paragraphs on screen are re-checked
  const beforeSwitch = checked.length;
  await ai.click("#settings-open");
  expect(await ai.isChecked("#use-glossary"), "A13: the glossary switch should be on by default");
  await ai.uncheck("#use-glossary");
  await ai.waitForTimeout(1800);
  expect((await ai.evaluate(() => localStorage.getItem("langfaix:useGlossary"))) === "false", "A13: the switch was not stored");
  expect(checked.length > beforeSwitch, "A13: the page was not checked again after the switch");

  expect(aiProblems.length === 0, `page errors in the AI test: ${aiProblems.join(" | ")}`);
  await ai.close();

  // ====================== The task pane: buttons on issue cards, and the personal dictionary ======================

  const CARD_PAGES = [
    ["He go to the Zyphor office. The Zyphor team found erors.", "Another erors line with Zyphor."],
    ["Zyphor again on page two."],
  ];
  const cards = await context.newPage();
  const cardProblems = [];
  cards.on("pageerror", (error) => cardProblems.push(String(error)));
  await cards.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  await cards.addInitScript((pages) => {
    // The previous section stored settings under the same origin. Start from a clean dictionary.
    localStorage.removeItem("langfaix:personalDictionary");
    document.addEventListener("DOMContentLoaded", () => {
      window.__fakeWord.setDocument(pages);
      window.__fakeWord.setVisiblePages([1]);
    });
  }, CARD_PAGES);
  await cards.goto(`${BASE}/addin/word-addin/taskpane.html`);
  const cardWord = (name, ...args) => cards.evaluate(([method, values]) => window.__fakeWord[method](...values), [name, args]);
  const cardStatus = (text, timeout = 6000) =>
    cards.waitForFunction((wanted) => document.querySelector("#status").textContent.trim() === wanted, text, { timeout }).catch(() => {});
  const cardList = () => cards.locator("#issues .issue .old").allTextContents();
  const cardOf = (text, nth = 0) => cards.locator("#issues .issue", { has: cards.locator(".old", { hasText: text }) }).nth(nth);
  const cardText = () => cardWord("paragraphs");
  // The lines drawn, as "paragraph:word", in document order (the fake Word returns them in drawing order).
  const lines = async () =>
    (await cardWord("underlines")).filter((mark) => mark.colour === "Red").sort((a, b) => a.paragraph - b.paragraph || CARD_PAGES.flat()[a.paragraph].indexOf(a.text) - CARD_PAGES.flat()[b.paragraph].indexOf(b.text)).map((mark) => `${mark.paragraph}:${mark.text}`);
  const sentToAi = improved.length;

  // C1. Six issues. Spelling cards have Add to dictionary, grammar cards do not. Each suggestion is a button.
  await cardStatus("6 issues on screen");
  expect(same(await cardList(), ["He go", "Zyphor", "Zyphor", "erors", "erors", "Zyphor"]), `C1: wrong list: ${JSON.stringify(await cardList())}`);
  expect((await cardOf("He go").locator("button.add-word").count()) === 0, "C1: a grammar card should not offer Add to dictionary");
  expect((await cardOf("Zyphor").locator("button.add-word").count()) === 1, "C1: a spelling card should offer Add to dictionary");
  expect(same(await cardOf("erors").locator("button.suggest").allTextContents(), ["errors", "errs", "euros", "eros"]), "C1: the card should list more suggestions than Word's popup can hold");
  await cards.screenshot({ path: join(SHOTS, "addin-cards.png") });

  // C2. A suggestion on a card goes into the document. The word occurs twice in the paragraph; the second card must replace the second occurrence.
  await cardOf("Zyphor", 1).locator("button.suggest", { hasText: "Zephyr" }).click();
  await cardStatus("5 issues on screen");
  expect((await cardText())[0] === "He go to the Zyphor office. The Zephyr team found erors.", `C2: the wrong occurrence was replaced: ${JSON.stringify((await cardText())[0])}`);
  expect((await cardWord("selected")) === null, "C2: clicking a suggestion also jumped to the issue");
  // Grammar suggestions are clickable too.
  await cardOf("He go").locator("button.suggest", { hasText: "He goes" }).click();
  await cardStatus("4 issues on screen");
  expect((await cardText())[0].startsWith("He goes to the Zyphor office."), `C2: the grammar suggestion was not applied: ${JSON.stringify((await cardText())[0])}`);
  await cards.waitForTimeout(1800); // wait for the re-check: no duplicate lines, and the fixed place is not flagged again
  expect(same(await lines(), ["0:Zyphor", "0:erors", "1:erors", "1:Zyphor"]), `C2: wrong underlines after two fixes: ${JSON.stringify(await lines())}`);

  // C3. Add to dictionary: all lines of the word go, it is stored on this computer, and an unseen page does not flag it either
  await cardOf("Zyphor").locator("button.add-word").click();
  await cardStatus("2 issues on screen");
  expect(same(await cardList(), ["erors", "erors"]), `C3: wrong list after adding to the dictionary: ${JSON.stringify(await cardList())}`);
  expect(same(await lines(), ["0:erors", "1:erors"]), `C3: underlines of the added word are still drawn: ${JSON.stringify(await lines())}`);
  const stored = JSON.parse((await cards.evaluate(() => localStorage.getItem("langfaix:personalDictionary"))) ?? "{}");
  expect(same((stored.entries ?? []).map((entry) => entry.word), ["Zyphor"]), `C3: the word was not stored: ${JSON.stringify(stored)}`);
  await cardWord("setVisiblePages", [2]);
  await cardStatus("No issues on screen");
  expect((await cards.textContent("#where")) === "Page 2" && !(await lines()).some((line) => line.endsWith("Zyphor")), `C3: the added word is marked on a page seen later: ${JSON.stringify(await lines())}`);
  await cardWord("setVisiblePages", [1]);
  await cardStatus("2 issues on screen");

  // C4. Dismiss on a card: this issue and the same one elsewhere go; the text is untouched
  await cardOf("erors").locator("button.dismiss").click();
  await cardStatus("No issues on screen");
  expect((await lines()).length === 0, `C4: underlines were left after Dismiss: ${JSON.stringify(await lines())}`);
  expect((await cardText())[1] === "Another erors line with Zyphor.", "C4: Dismiss changed the text");

  // C5. The dictionary in the settings is an editable text box. Emptied and saved: the word is flagged again
  await cards.click("#settings-open");
  expect((await cards.inputValue("#dict-words")) === "Zyphor\n", `C5: the settings do not show the dictionary: ${JSON.stringify(await cards.inputValue("#dict-words"))}`);
  await cards.fill("#dict-words", "");
  await cards.click("#dict-save");
  await cardStatus("2 issues on screen");
  expect((await cards.textContent("#dict-status")) === "Saved. 0 words.", `C5: wrong confirmation: "${await cards.textContent("#dict-status")}"`);
  expect(same(await lines(), ["0:Zyphor", "1:Zyphor"]), `C5: the removed word was not marked again: ${JSON.stringify(await lines())}`);
  // A pasted word list: a lower-case word covers any case; the too-long line is refused with a reason.
  await cards.fill("#dict-words", `zyphor\n${"y".repeat(80)}\nzyphor\n`);
  await cards.click("#dict-save");
  await cardStatus("No issues on screen");
  expect(((await cards.textContent("#dict-status")) ?? "").startsWith("Saved. 1 word. 1 not saved:"), `C5: wrong summary: "${await cards.textContent("#dict-status")}"`);
  expect((await cards.inputValue("#dict-words")) === "zyphor\n", "C5: the box should show the tidied list after saving");

  // No AI button was clicked in this whole section, so no text went to the AI.
  expect(improved.length === sentToAi, "C: text was sent to the AI by a card button that is not an AI button");
  expect(cardProblems.length === 0, `page errors in the card test: ${cardProblems.join(" | ")}`);
  await cards.close();

  // ====================== The task pane: hint lines, AI rewriting across paragraphs, term lookup ======================

  // Put a few made-up rows into the glossary for the lookups. The owner of this key is the glossary admin in this test.
  for (const term of [
    { zh: "归档中心", en: "Archiving Center", applies_to: "before 3.1.60" },
    { zh: "归档中心", en: "Archive Center", applies_to: "3.1.60 and later", variants: ["Arch Center"], note: "Renamed in 3.1.60." },
    { zh: "", en: "Zyphor Cloud" },
  ]) {
    const added = await fetch(`${BASE}/glossary/terms`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GOOD_KEY}` }, body: JSON.stringify(term) });
    expect(added.status === 201, `could not put a test term into the glossary: HTTP ${added.status}`);
  }

  const MORE_PAGES = [
    ["Intro with a sentense.", "Second has the documant here.", "Third is fine.", "This paragraph has a mistaek and also erors today. A fine short one here."],
  ];
  const more = await context.newPage();
  const moreProblems = [];
  more.on("pageerror", (error) => moreProblems.push(String(error)));
  await more.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  await more.addInitScript((pages) => {
    localStorage.removeItem("langfaix:personalDictionary");
    // The previous section turned the team glossary off. It must be on here: terms inserted into the document later must not count as typos.
    localStorage.removeItem("langfaix:useGlossary");
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => window.__copied.push(text) } });
    document.addEventListener("DOMContentLoaded", () => {
      window.__fakeWord.setDocument(pages);
      window.__fakeWord.setVisiblePages([1]);
    });
  }, MORE_PAGES);
  await more.goto(`${BASE}/addin/word-addin/taskpane.html`);
  const moreWord = (name, ...args) => more.evaluate(([method, values]) => window.__fakeWord[method](...values), [name, args]);
  const moreStatus = (text, timeout = 6000) => more.waitForFunction((wanted) => document.querySelector("#status").textContent.trim() === wanted, text, { timeout }).catch(() => {});
  const coloured = async (colour) => (await moreWord("underlines")).filter((mark) => mark.colour === colour).map((mark) => mark.text);
  const moreAi = more.locator("#ai");
  const hintCards = more.locator("#issues .issue.hint");
  const HINTED = "This paragraph has a mistaek and also erors today.";
  const sentToAiBefore = improved.length;

  // H1. Two errors in one sentence: the sentence is hinted. The lavender line breaks at the red ones into three pieces and overlaps none
  await moreStatus("4 issues on screen");
  expect((await hintCards.count()) === 1 && ((await hintCards.locator(".sentence").textContent()) ?? "").includes(HINTED), `H1: wrong hint cards: ${await hintCards.count()}`);
  expect(same(await coloured("Lavender"), ["This paragraph has a ", " and also ", " today."]), `H1: wrong purple pieces: ${JSON.stringify(await coloured("Lavender"))}`);
  expect(same((await coloured("Red")).sort(), ["documant", "erors", "mistaek", "sentense"]), `H1: wrong red underlines: ${JSON.stringify(await coloured("Red"))}`);
  // Hints are computed locally: no text has gone to the AI. The count at the top is of rule issues; hints are not included
  expect(improved.length === sentToAiBefore, "H1: drawing the hint sent text to the AI");
  await more.screenshot({ path: join(SHOTS, "addin-hint.png") });

  // H2. Pointing at one piece of a hint line in the document lights up its hint card
  const piece = (await moreWord("underlines")).find((mark) => mark.colour === "Lavender");
  await moreWord("userHovers", piece.id);
  await more.waitForTimeout(200);
  expect((await more.locator("#issues .issue.hint.current").count()) === 1, "H2: hovering a purple piece did not highlight the hint card");

  // H3. Hint lines turned off in the settings: the lavender lines go, the hints stay listed; turned on again, the lines return
  await more.click("#settings-open");
  expect(await more.isChecked("#hint-lines"), "H3: purple underlines should be on by default");
  await more.uncheck("#hint-lines");
  await more.waitForFunction(() => window.__fakeWord.underlines().every((mark) => mark.colour !== "Lavender"), null, { timeout: 5000 }).catch(() => {});
  expect((await coloured("Lavender")).length === 0 && (await hintCards.count()) === 1, `H3: with the lines off, the hint should stay listed without underlines: ${JSON.stringify(await coloured("Lavender"))}, ${await hintCards.count()} card(s)`);
  expect((await coloured("Red")).length === 4, "H3: switching the purple lines off touched the red ones");
  expect((await more.evaluate(() => localStorage.getItem("langfaix:hintLines"))) === "false", "H3: the switch was not stored");
  await more.check("#hint-lines");
  await more.waitForFunction(() => window.__fakeWord.underlines().some((mark) => mark.colour === "Lavender"), null, { timeout: 5000 }).catch(() => {});
  expect((await coloured("Lavender")).length === 3, "H3: switching the purple lines back on did not redraw them");
  await more.click("#settings-close");

  // M1. AI rewriting across a selection over two paragraphs: the end of the first plus the second. One request; each paragraph's edits go back to it
  await moreWord("selectAcross", 0, "a sentense");
  await more.click("#ai-open");
  await moreAi.locator("button.option").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(same(await moreAi.locator("button.option .label").allTextContents(), ["Improve selection"]), "M1: a selection across paragraphs should offer exactly Improve selection");
  await moreAi.locator("button.option").click();
  await moreAi.locator(".cost.total").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  expect(same(improved.slice(sentToAiBefore), ["a sentense.", "Second has the documant here."]), `M1: wrong text sent for the selection: ${JSON.stringify(improved.slice(sentToAiBefore))}`);
  expect((await moreAi.locator(".section").count()) === 2, "M1: two sentences should give two sections");
  await moreAi.locator("button.accept", { hasText: "Accept" }).click();
  await moreAi.locator(".note").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(same((await moreWord("paragraphs")).slice(0, 2), ["Intro with a sentence.", "Second has the document here."]), `M1: wrong text after Accept: ${JSON.stringify((await moreWord("paragraphs")).slice(0, 2))}`);
  expect(((await moreAi.locator(".note").first().textContent()) ?? "") === "2 changes applied.", "M1: wrong confirmation");
  await moreStatus("2 issues on screen");

  // H4. Improve with AI on a hint card: that sentence is sent. After Accept it is no longer hinted
  await hintCards.locator("button.ai-link").click();
  await moreAi.locator(".diff").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  expect(improved.at(-1) === HINTED, `H4: wrong sentence sent from the hint card: ${JSON.stringify(improved.at(-1))}`);
  await moreAi.locator("button.accept", { hasText: "Accept" }).click();
  await moreStatus("No issues on screen");
  expect((await moreWord("paragraphs"))[3] === "This paragraph has a mistake and also errors today. A fine short one here.", `H4: wrong text after Accept: ${JSON.stringify((await moreWord("paragraphs"))[3])}`);
  await more.waitForTimeout(1800);
  expect((await hintCards.count()) === 0 && (await coloured("Lavender")).length === 0, "H4: the sentence the AI has rewritten is hinted again");

  // H5. Dismiss on a hint card: the hint line goes, red lines stay; typing and a re-check do not bring it back
  await moreWord("userTypes", 2, "This one has a sentense and a documant inside.");
  await more.locator("#issues .issue.hint").waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  expect((await hintCards.count()) === 1 && (await coloured("Lavender")).length === 3, `H5: a new hint was expected: ${await hintCards.count()} card(s), ${JSON.stringify(await coloured("Lavender"))}`);
  await hintCards.locator("button.dismiss").click();
  await more.waitForTimeout(400);
  expect((await hintCards.count()) === 0 && (await coloured("Lavender")).length === 0, "H5: Dismiss did not remove the hint");
  expect(same((await coloured("Red")).sort(), ["documant", "sentense"]), `H5: Dismiss on a hint touched the red underlines: ${JSON.stringify(await coloured("Red"))}`);
  await moreWord("userTypes", 2, "This one has a sentense and a documant inside. More.");
  await more.waitForTimeout(2400);
  // The sentence is unchanged (another one was appended), so it is still not hinted.
  expect((await more.locator("#issues .issue.hint .sentence").allTextContents()).every((text) => !text.includes("has a sentense")), "H5: the dismissed hint came back after typing");

  // L1. Term lookup: Chinese in shows the English, English in shows the Chinese. Two translations of one Chinese term show their applies-to
  const rows = () => more.locator("#lookup .term-row");
  await more.fill("#term", "归档中心");
  await rows().first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  expect(same(await more.locator("#lookup button.copy.en").allTextContents(), ["Archive Center", "Archiving Center"]) || same(await more.locator("#lookup button.copy.en").allTextContents(), ["Archiving Center", "Archive Center"]), `L1: typing Chinese: ${JSON.stringify(await more.locator("#lookup button.copy.en").allTextContents())}`);
  expect((await more.locator("#lookup .applies").allTextContents()).some((text) => text === "Applies to: 3.1.60 and later"), "L1: applies-to is not shown");
  expect(same(await more.locator("#lookup .wrong s").allTextContents(), ["Arch Center"]), "L1: the wrong forms are not listed");
  await more.fill("#term", "zyphor");
  await more.waitForFunction(() => [...document.querySelectorAll("#lookup button.copy.en")].map((b) => b.textContent).join() === "Zyphor Cloud", null, { timeout: 6000 }).catch(() => {});
  expect((await more.locator("#lookup button.copy.zh").count()) === 0, "L1: a row without Chinese should not show an empty Chinese button");
  await more.screenshot({ path: join(SHOTS, "addin-lookup.png") });
  // Click to copy.
  await more.locator("#lookup button.copy.en").click();
  await more.waitForTimeout(200);
  expect(same(await more.evaluate(() => window.__copied), ["Zyphor Cloud"]), "L1: clicking a term did not copy it");
  expect(((await more.locator("#lookup .note").textContent()) ?? "") === "Copied: Zyphor Cloud", "L1: no confirmation after copying");
  // Insert: at the cursor in the document.
  await moreWord("putCursorIn", 2, "is fine");
  await moreWord("selectText", 2, "inside");
  await more.locator("#lookup button.insert").click();
  await more.waitForTimeout(300);
  expect((await moreWord("paragraphs"))[2].includes("a documant Zyphor Cloud."), `L1: Insert did not put the term at the selection: ${JSON.stringify((await moreWord("paragraphs"))[2])}`);
  // Nothing found, and clearing.
  await more.fill("#term", "nothing like this");
  await more.waitForFunction(() => document.querySelector("#lookup .note")?.textContent === "No term like this in the glossary.", null, { timeout: 6000 }).catch(() => {});
  expect((await rows().count()) === 0, "L1: wrong result for a term that is not in the glossary");
  await more.fill("#term", "");
  await more.locator("#lookup").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  expect(await more.locator("#lookup").isHidden(), "L1: clearing the box should close the results");

  // F1. "Follow the cursor" in the settings: only the paragraph at the cursor is handled
  await moreWord("moveCursorTo", 2);
  await more.click("#settings-open");
  await more.check("#follow-cursor");
  await more.waitForFunction(() => document.querySelector("#where").textContent === "At the cursor", null, { timeout: 5000 }).catch(() => {});
  expect((await more.textContent("#where")) === "At the cursor", "F1: the pane does not say that it follows the cursor");
  await more.waitForTimeout(1800);
  expect(same(await more.locator("#issues .issue .old").allTextContents(), ["sentense", "documant"]), `F1: the list should show the paragraph at the cursor: ${JSON.stringify(await more.locator("#issues .issue .old").allTextContents())}`);
  await moreWord("moveCursorTo", 0);
  await moreStatus("No issues on screen");
  await more.uncheck("#follow-cursor");
  await more.waitForFunction(() => document.querySelector("#where").textContent === "Page 1", null, { timeout: 5000 }).catch(() => {});
  expect((await more.textContent("#where")) === "Page 1", "F1: switching back to following the pages did not work");

  // G1. The language in Settings: the same list as the extension; saved when chosen, and the paragraphs on screen are checked again in it.
  expect((await more.inputValue("#language")) === "en-US", `G1: the language should start as en-US, it is ${await more.inputValue("#language")}`);
  const wordGroups = await more.locator("#language optgroup").evaluateAll((nodes) => nodes.map((node) => node.label));
  expect(JSON.stringify(wordGroups) === JSON.stringify(["English", "Chinese", "Catalan", "Dutch", "French", "German"]), `G1: the language groups are ${JSON.stringify(wordGroups)}`);
  expect(checkedAs.length > 0 && checkedAs.every((code) => code === "en-US"), `G1: until now every check should have asked for en-US: ${JSON.stringify([...new Set(checkedAs)])}`);
  const checksBefore = checkedAs.length;
  await more.selectOption("#language", "de-AT");
  await more.waitForFunction(() => document.querySelector("#settings-status").textContent.includes("German (Austria)"), null, { timeout: 3000 }).catch(() => {});
  expect(((await more.textContent("#settings-status")) ?? "").includes("Checking as German (Austria)."), `G1: no confirmation after choosing a language: "${await more.textContent("#settings-status")}"`);
  await more.waitForTimeout(2000);
  expect(checkedAs.length > checksBefore, "G1: choosing a language did not check the text on screen again");
  expect(checkedAs.slice(checksBefore).every((code) => code === "de-AT"), `G1: the checks after choosing German (Austria) asked for ${JSON.stringify([...new Set(checkedAs.slice(checksBefore))])}`);
  expect((await more.evaluate(() => localStorage.getItem("langfaix:language"))) === JSON.stringify("de-AT"), "G1: the language was not stored");
  await more.locator("#language").scrollIntoViewIfNeeded();
  await more.screenshot({ path: join(SHOTS, "addin-language.png") });
  // 改回去，后面的测试页用的是同一份存储
  await more.selectOption("#language", "en-US");
  await more.waitForTimeout(300);

  expect(moreProblems.length === 0, `page errors in the hints test: ${moreProblems.join(" | ")}`);
  await more.close();

  // S12. An older Word (it cannot report the pages on screen): falls back to the paragraph at the cursor, and the box in the settings cannot be unticked
  const old = await context.newPage();
  const oldProblems = [];
  old.on("pageerror", (error) => oldProblems.push(String(error)));
  await old.route("https://appsforoffice.microsoft.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_OFFICE }));
  await old.addInitScript(() => {
    window.__fakeOfficeOptions = { unsupported: ["WordApiDesktop"] };
    localStorage.removeItem("langfaix:followCursor");
    document.addEventListener("DOMContentLoaded", () => window.__fakeWord.setDocument([["First has a sentense.", "Second has the documant."]]));
  });
  await old.goto(`${BASE}/addin/word-addin/taskpane.html`);
  const oldStatus = (text) => old.waitForFunction((wanted) => document.querySelector("#status").textContent.trim() === wanted, text, { timeout: 6000 }).catch(() => {});
  await oldStatus("1 issue on screen");
  expect((await old.textContent("#where")) === "At the cursor" && same(await old.locator("#issues .issue .old").allTextContents(), ["sentense"]), `S12: an older Word should follow the cursor: "${await old.textContent("#where")}" ${JSON.stringify(await old.locator("#issues .issue .old").allTextContents())}`);
  await old.evaluate(() => window.__fakeWord.moveCursorTo(1));
  await old.waitForFunction(() => document.querySelector("#issues .issue .old")?.textContent === "documant", null, { timeout: 6000 }).catch(() => {});
  expect(same(await old.locator("#issues .issue .old").allTextContents(), ["documant"]), "S12: moving the cursor did not move the checking");
  await old.click("#settings-open");
  expect((await old.isChecked("#follow-cursor")) && (await old.isDisabled("#follow-cursor")), "S12: on an older Word the follow-the-cursor box should be ticked and fixed");
  expect(oldProblems.length === 0, `S12: page errors on an older Word: ${oldProblems.join(" | ")}`);
  await old.close();

  // ====================== The Word install guide for users ======================
  const guidePath = join(BUILD, "langfaix-word-install-guide.html");
  if (!existsSync(guidePath)) {
    failures.push(`there is no ${guidePath}. Run deploy/pack-word-addin.ps1 first.`);
  } else {
    const guideHtml = readFileSync(guidePath, "utf8");
    expect(!guideHtml.includes("{{"), "the Word install guide still has a {{...}} mark that was not filled in");
    expect(!guideHtml.includes("<!--"), "the developer notes were not removed from the Word install guide");
    // Button and option names in the guide must match the page. If the page renames one and the guide does not follow, users cannot find it.
    const paneHtml = ["taskpane.html", "taskpane.js", "lib/wording.js"].map((name) => readFileSync(new URL(`../word-addin/${name}`, import.meta.url), "utf8")).join("");
    for (const label of ["Improve with AI", "Settings", "API key", "Save", "Dismiss", "Add to dictionary", "Accept", "Pause", "Resume", "Insert", "Could read better", "Cannot reach the server"]) {
      expect(guideHtml.includes(label) && paneHtml.includes(label), `the Word install guide and the pane do not agree on the label "${label}"`);
    }
    const manifestXml = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
    expect(manifestXml.includes('DefaultValue="Check text"') && guideHtml.includes("Check text"), 'the guide and the manifest do not agree on the ribbon button "Check text"');

    // The zip for users: the file name in the guide matches, all four files are in it and
    // each equals the current file (catches a changed install script or regenerated manifest
    // without a re-pack).
    const version = /<Version>([^<]+)<\/Version>/.exec(manifestXml)?.[1] ?? "";
    const zipName = `langfaix-word-addin-${version}.zip`;
    const zipPath = join(BUILD, zipName);
    expect(guideHtml.includes(zipName), `the Word install guide does not mention ${zipName}`);
    expect(guideHtml.includes(`版本 ${version}`), "the Word install guide does not show the manifest version");
    const installer = readFileSync(new URL("../deploy/install-word-addin.ps1", import.meta.url), "utf8");
    // The sentence quoted in the guide must be what the install script really prints.
    expect(guideHtml.includes("Installed langfAIx for Word") && installer.includes("Installed langfAIx for Word"), "the guide and the install script do not agree on the success message");
    if (!existsSync(zipPath)) {
      failures.push(`there is no ${zipPath}. Run deploy/pack-word-addin.ps1 first.`);
    } else {
      const inZip = execFileSync(TAR, ["-tf", zipPath], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).sort();
      const wanted = {
        "Install.cmd": new URL("../deploy/word-install/Install.cmd", import.meta.url),
        "Uninstall.cmd": new URL("../deploy/word-install/Uninstall.cmd", import.meta.url),
        "install-word-addin.ps1": new URL("../deploy/install-word-addin.ps1", import.meta.url),
        "langfaix-word-manifest.xml": pathToFileURL(manifestPath),
      };
      expect(JSON.stringify(inZip) === JSON.stringify(Object.keys(wanted).sort()), `the Word package should hold exactly ${Object.keys(wanted).join(", ")}, it holds ${inZip.join(", ")}`);
      const unzipped = mkdtempSync(join(tmpdir(), "langfaix-word-zip-"));
      execFileSync(TAR, ["-xf", zipPath, "-C", unzipped]);
      for (const [name, source] of Object.entries(wanted)) {
        const packedFile = join(unzipped, name);
        expect(existsSync(packedFile) && readFileSync(packedFile).equals(readFileSync(source)), `${name} in the Word package is not the same as the current file. Run deploy/pack-word-addin.ps1 again.`);
        expect(guideHtml.includes(name) || name.endsWith(".ps1") || name.endsWith(".xml"), `the Word install guide does not mention ${name}`);
      }
      // The install script must start with a BOM: without one Windows PowerShell 5.1 misreads any non-ASCII character in it.
      expect(readFileSync(join(unzipped, "install-word-addin.ps1")).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "install-word-addin.ps1 in the package has no BOM");
      console.log(`Word package: ${zipName} holds ${inZip.join(", ")}`);
    }

    const guide = await context.newPage();
    await guide.setViewportSize({ width: 900, height: 1100 });
    await guide.goto(pathToFileURL(guidePath).href);
    await guide.screenshot({ path: join(SHOTS, "addin-word-guide.png"), fullPage: true });
    const pdf = await guide.pdf({ format: "A4", margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" } });
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    // Like the extension's guide, designed for two pages: installing on the first, everyday reference on the second.
    expect(pages <= 2, `the Word install guide prints on ${pages} pages, it should fit on 2`);
    console.log(`Word install guide: prints on ${pages} A4 page${pages === 1 ? "" : "s"}, screenshot in shots/addin-word-guide.png`);
    await guide.close();
  }
} catch (error) {
  failures.push(`the test could not finish: ${String(error).split("\n")[0]}`);
} finally {
  await browser?.close();
  backend.kill();
  fake.close();
}

console.log(`screenshots: ${SHOTS}`);
if (failures.length === 0) {
  console.log("RESULT: PASS (the page works against a fake Word; the real Word still has to be tried by hand)");
} else {
  for (const failure of failures) console.log(`FAILED: ${failure}`);
  if (/Traceback|ERROR/.test(backendLog)) console.log(`--- backend log ---\n${backendLog.slice(-3000)}`);
  console.log("RESULT: FAIL");
}
process.exit(failures.length === 0 ? 0 : 1);
