// Browser tests for the toolbar popup and the options page: lookup (both directions), the
// glossary switch, the link to the admin page, the personal dictionary.
//
// As in overlay.mjs, the extension's pages are opened as plain files and chrome.* is
// replaced by stand-ins. So the extension is not loaded into the browser, no server is
// contacted and no key is needed. Lookup results come from the small made-up glossary
// below. (How the server searches and sorts is covered by the backend tests; this only
// tests how the pages display and behave.)
//
// Usage (in the e2e folder):
//   npm run popup
//
// Screenshots go to shots/, named popup-*.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const POPUP = new URL("../browser-extension/popup/popup.html", import.meta.url).href;
const OPTIONS = new URL("../browser-extension/options/options.html", import.meta.url).href;
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

// A made-up glossary.
const ROWS = [
  { id: 1, zh: "归档中心", en: "Archiving Center", category: "Feature", applies_to: "before 3.1.60", variants: [], note: "" },
  { id: 2, zh: "归档中心", en: "Archive Center", category: "Feature", applies_to: "3.1.60 and later", variants: ["Arch Center"], note: "Renamed in 3.1.60." },
  { id: 3, zh: "网页管理界面", en: "WebUI", category: "Feature", applies_to: "", variants: ["Web UI", "web-ui"], note: "" },
  { id: 4, zh: "", en: "Zyphor Cloud", category: "Product", applies_to: "", variants: [], note: "" },
];

// Stands in for the server's lookup: a row matches if its Chinese, English or wrong forms contain the input, case-insensitively.
function fakeLookup(query) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  return ROWS.filter((row) => [row.zh, row.en, ...row.variants].some((value) => value.toLowerCase().includes(wanted)));
}

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--allow-file-access-from-files"] });
const problems = [];

// Open a page with the stand-ins. stored is what chrome.storage.local already holds.
async function open(url, stored, behaviour = {}) {
  const context = await browser.newContext({ viewport: { width: 520, height: 640 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(String(error)));
  const seen = { messages: [], copied: [], optionsOpened: 0 };

  await page.exposeFunction("__send", async (message) => {
    seen.messages.push(message);
    if (message.type === "lookup") {
      if (behaviour.lookupError) return { ok: false, error: behaviour.lookupError };
      return { ok: true, data: { results: fakeLookup(message.query) } };
    }
    if (message.type === "check") return { ok: true, data: { language: "en-US", matches: [], sentences: [] } };
    if (message.type === "health") return { ok: true, data: { status: "ok" } };
    return { ok: false, error: "not supported in this test" };
  });
  await page.exposeFunction("__copied", (text) => seen.copied.push(text));
  await page.exposeFunction("__optionsOpened", () => seen.optionsOpened++);
  await page.addInitScript((initial) => {
    const data = { ...initial };
    window.__stored = data; // lets the test see what the settings stored
    window.chrome = {
      runtime: { id: "test", sendMessage: (message) => window.__send(message), openOptionsPage: () => window.__optionsOpened() },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])),
          set: async (values) => Object.assign(data, values),
        },
      },
    };
    // A headless browser has no usable clipboard: a stand-in records the text.
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => window.__copied(text) } });
  }, stored);
  await page.goto(url);
  return { page, seen, context };
}

const SETTINGS = { apiUrl: "https://glossary.example.com/api", apiKey: "sk-user", language: "en-US" };

// ---------- Popup: lookup ----------

{
  const { page, seen, context } = await open(POPUP, SETTINGS);
  const english = () => page.locator("#results .copy.en").allTextContents();
  const chinese = () => page.locator("#results .copy.zh").allTextContents();
  const statusText = async () => ((await page.textContent("#lookup-status")) ?? "").trim();
  // Type into the lookup box and wait for results.
  const type = async (text) => {
    await page.fill("#term", text);
    await page.waitForTimeout(600);
  };

  // P1. Opens on lookup with the caret in the box
  expect(await page.locator("#pane-lookup").isVisible(), "P1: the popup should open on the glossary tab");
  expect(await page.evaluate(() => document.activeElement?.id === "term"), "P1: the lookup box should have the cursor");
  expect(await page.locator("#glossary-off").isHidden(), "P1: the switched-off notice is shown although the glossary is on");

  // P2. Chinese input: one Chinese term with two English terms, both rows with their applies-to
  await type("归档中心");
  expect(same(await english(), ["Archiving Center", "Archive Center"]), `P2: typing Chinese: ${JSON.stringify(await english())}`);
  expect(same(await chinese(), ["归档中心", "归档中心"]), "P2: the Chinese term is not shown next to the English one");
  const metas = await page.locator("#results .applies").allTextContents();
  expect(same(metas, ["Applies to: before 3.1.60", "Applies to: 3.1.60 and later"]), `P2: applies-to is missing: ${JSON.stringify(metas)}`);
  expect((await statusText()) === "2 terms. Click a term to copy it.", `P2: wrong status: "${await statusText()}"`);
  await page.screenshot({ path: join(SHOTS, "popup-P2-chinese-to-english.png") });

  // P3. English input: the same rows, with their Chinese. That is "both directions".
  await type("center");
  expect(same(await english(), ["Archiving Center", "Archive Center"]), `P3: typing English: ${JSON.stringify(await english())}`);
  expect(same(await chinese(), ["归档中心", "归档中心"]), `P3: typing English should show the Chinese too: ${JSON.stringify(await chinese())}`);
  await page.screenshot({ path: join(SHOTS, "popup-P3-english-to-chinese.png") });

  // P4. Clicking the English copies the English; clicking the Chinese copies the Chinese
  await page.locator("#results .copy.en").nth(1).click();
  await page.locator("#results .copy.zh").first().click();
  await page.waitForTimeout(200);
  expect(same(seen.copied, ["Archive Center", "归档中心"]), `P4: wrong text copied: ${JSON.stringify(seen.copied)}`);
  expect((await statusText()) === "Copied: 归档中心", `P4: no confirmation after copying: "${await statusText()}"`);

  // P5. A wrong form: shows what to write and which forms to avoid
  await type("web ui");
  expect(same(await english(), ["WebUI"]), `P5: typing a wrong form: ${JSON.stringify(await english())}`);
  expect(same(await page.locator("#results .wrong s").allTextContents(), ["Web UI", "web-ui"]), "P5: the wrong forms are not listed");
  await page.screenshot({ path: join(SHOTS, "popup-P5-wrong-form.png") });

  // P6. A row with English only: no empty Chinese button
  await type("zyphor");
  expect(same(await english(), ["Zyphor Cloud"]) && (await chinese()).length === 0, "P6: a row without Chinese should show only the English term");

  // P7. Nothing found, and clearing the box
  await type("nothing like this");
  expect((await english()).length === 0 && (await statusText()) === "No term like this in the glossary.", `P7: wrong message when nothing is found: "${await statusText()}"`);
  await type("");
  expect((await statusText()) === "" && (await english()).length === 0, "P7: clearing the box should clear the results");

  // P8. Every lookup went to the background script with the text as typed
  const queries = seen.messages.filter((message) => message.type === "lookup").map((message) => message.query);
  expect(same(queries, ["归档中心", "center", "web ui", "zyphor", "nothing like this"]), `P8: wrong lookup requests: ${JSON.stringify(queries)}`);

  // P9. The link to the full glossary follows the server address
  expect((await page.getAttribute("#openGlossary", "href")) === "https://glossary.example.com/api/admin/", "P9: wrong link to the full glossary");

  // P10. Quick check is still on the other tab and works
  await page.click("#tab-check");
  expect(await page.locator("#pane-check").isVisible() && (await page.locator("#pane-lookup").isHidden()), "P10: the quick check tab did not open");
  await page.fill("#text", "Hello there.");
  await page.click("#check");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("No issues"), null, { timeout: 3000 }).catch(() => {});
  expect(((await page.textContent("#status")) ?? "").includes("No issues found"), "P10: the quick check did not run");
  await page.click("#openOptions");
  await page.waitForTimeout(100);
  expect(seen.optionsOpened === 1, "P10: the Options link did nothing");
  await context.close();
}

// P11. No key: the reason is shown, not a blank
{
  const { page, context } = await open(POPUP, { ...SETTINGS, apiKey: "" }, { lookupError: "The API key is not set. Open the extension options to set it." });
  await page.fill("#term", "policy");
  await page.waitForTimeout(600);
  const status = ((await page.textContent("#lookup-status")) ?? "").trim();
  expect(status.includes("API key is not set"), `P11: the reason is not shown: "${status}"`);
  expect(await page.locator("#lookup-status.error").count() === 1, "P11: the reason should be shown as an error");
  await page.screenshot({ path: join(SHOTS, "popup-P11-no-key.png") });
  await context.close();
}

// P12. Glossary turned off in the settings: the popup says so, and lookup still works
{
  const { page, context } = await open(POPUP, { ...SETTINGS, useGlossary: false });
  expect(await page.locator("#glossary-off").isVisible(), "P12: the popup does not say the glossary is switched off");
  await page.fill("#term", "网页");
  await page.waitForTimeout(600);
  expect(same(await page.locator("#results .copy.en").allTextContents(), ["WebUI"]), "P12: lookup should still work when the glossary is switched off");
  await page.screenshot({ path: join(SHOTS, "popup-P12-switched-off.png") });
  await context.close();
}

// ---------- Options page: the glossary switch ----------

{
  const { page, context } = await open(OPTIONS, SETTINGS);
  await page.waitForFunction(() => !document.querySelector("#form").disabled, null, { timeout: 3000 });
  const stored = () => page.evaluate(() => window.__stored);

  // O1. On by default; the link points to the admin page
  expect(await page.isChecked("#useGlossary"), "O1: the glossary switch should be on by default");
  expect((await page.getAttribute("#glossaryLink", "href")) === "https://glossary.example.com/api/admin/", "O1: wrong link to the glossary page");
  expect(await page.locator("#glossaryLink").isVisible(), "O1: the link to the glossary page is hidden");

  // O2. Saved at once, without Save. Address and key are untouched.
  await page.uncheck("#useGlossary");
  await page.waitForTimeout(150);
  expect((await stored()).useGlossary === false, `O2: turning the switch off was not stored: ${JSON.stringify(await stored())}`);
  expect(((await page.textContent("#status")) ?? "").includes("The team glossary is off."), "O2: no confirmation after turning the switch off");
  expect((await stored()).apiKey === "sk-user" && (await stored()).apiUrl === SETTINGS.apiUrl, "O2: the switch changed the address or the key");
  await page.screenshot({ path: join(SHOTS, "popup-O2-options-switch.png"), fullPage: true });

  // O3. A later Save of other settings does not silently switch it back
  await page.selectOption("#language", "en-GB");
  await page.click("#save");
  await page.waitForTimeout(150);
  expect((await stored()).language === "en-GB" && (await stored()).useGlossary === false, "O3: Save flipped the glossary switch back");

  // O4. The language list: English, Chinese and the languages with 3,000 or more rules. Chinese can be chosen and is stored.
  const languageGroups = await page.locator("#language optgroup").evaluateAll((nodes) => nodes.map((node) => node.label));
  expect(JSON.stringify(languageGroups) === JSON.stringify(["English", "Chinese", "Catalan", "Dutch", "French", "German"]), `O4: the language groups are ${JSON.stringify(languageGroups)}`);
  const languageCodes = await page.locator("#language option").evaluateAll((nodes) => nodes.map((node) => node.value));
  expect(languageCodes.length === 17 && new Set(languageCodes).size === 17, `O4: there should be 17 different languages, there are ${languageCodes.length}`);
  expect(!languageCodes.includes("de"), "O4: plain 'de' must not be offered, it gets no spell check");
  await page.selectOption("#language", "zh-CN");
  await page.click("#save");
  await page.waitForTimeout(150);
  expect((await stored()).language === "zh-CN", `O4: Chinese was not stored: ${JSON.stringify(await stored())}`);
  await page.locator("#language").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, "popup-O4-options-language.png"), fullPage: true });

  await page.check("#useGlossary");
  await page.waitForTimeout(150);
  expect((await stored()).useGlossary === true, "O3: turning the switch back on was not stored");
  await context.close();
}

// O4. Turned off last time: the switch shows off on reopening. No link while there is no server address.
{
  const { page, context } = await open(OPTIONS, { useGlossary: false });
  await page.waitForFunction(() => !document.querySelector("#form").disabled, null, { timeout: 3000 });
  expect(!(await page.isChecked("#useGlossary")), "O4: the switch does not show that the glossary is off");
  expect(await page.locator("#glossaryLink").isHidden(), "O4: a link to the glossary page is shown although there is no server address");
  await context.close();
}

// ---------- Options page: personal dictionary ----------

{
  const { page, context } = await open(OPTIONS, SETTINGS);
  await page.waitForFunction(() => !document.querySelector("#form").disabled, null, { timeout: 3000 });
  const stored = () => page.evaluate(() => window.__stored);
  const words = () => page.locator("#dictList li span").allTextContents();
  const savedWords = async () => ((await stored()).personalDictionary?.entries ?? []).map((entry) => entry.word);
  const dictStatus = async () => ((await page.textContent("#dictStatus")) ?? "").trim();
  const settle = () => page.waitForTimeout(150);

  // D1. Empty at first, and says so; nothing to export
  expect(((await page.textContent("#dictCount")) ?? "") === "No words yet.", `D1: an empty dictionary should say so: "${await page.textContent("#dictCount")}"`);
  expect(await page.isDisabled("#dictExport"), "D1: Export should be disabled while the dictionary is empty");

  // D2. Adding a word: by button or Enter. Saved at once, without Save. Address and key are untouched.
  await page.fill("#dictWord", "  Zyphor ");
  await page.click("#dictAdd");
  await settle();
  expect(same(await words(), ["Zyphor"]) && same(await savedWords(), ["Zyphor"]), `D2: the word was not added: shown ${JSON.stringify(await words())}, stored ${JSON.stringify(await savedWords())}`);
  expect((await dictStatus()) === 'Added "Zyphor".', `D2: wrong confirmation: "${await dictStatus()}"`);
  expect((await page.inputValue("#dictWord")) === "", "D2: the box was not cleared after adding");
  await page.fill("#dictWord", "webui");
  await page.press("#dictWord", "Enter");
  await settle();
  expect(same(await words(), ["webui", "Zyphor"]), `D2: Enter did not add the word, or the list is not sorted: ${JSON.stringify(await words())}`);
  expect(((await page.textContent("#dictCount")) ?? "") === "2 words", "D2: the count is wrong");
  expect((await stored()).apiKey === "sk-user" && (await stored()).apiUrl === SETTINGS.apiUrl, "D2: adding a word changed the address or the key");

  // D3. An existing word, an empty one, a too-long one: each explained, dictionary unchanged
  await page.fill("#dictWord", "Zyphor");
  await page.click("#dictAdd");
  await settle();
  expect((await dictStatus()) === '"Zyphor" is already in the dictionary.', `D3: adding a word twice: "${await dictStatus()}"`);
  await page.fill("#dictWord", "   ");
  await page.click("#dictAdd");
  await settle();
  expect((await dictStatus()) === "Enter a word." && (await page.locator("#dictStatus.error").count()) === 1, `D3: an empty word: "${await dictStatus()}"`);
  await page.fill("#dictWord", "x".repeat(80));
  await page.click("#dictAdd");
  await settle();
  expect((await dictStatus()).includes("too long"), `D3: an overlong word: "${await dictStatus()}"`);
  expect(same(await savedWords(), ["Zyphor", "webui"]), "D3: a refused word changed the dictionary");
  await page.fill("#dictWord", "");

  // D4. A later Save of other settings does not wipe the dictionary
  await page.selectOption("#language", "en-GB");
  await page.click("#save");
  await settle();
  expect(same(await savedWords(), ["Zyphor", "webui"]), "D4: Save wiped the dictionary");

  // D5. Import by pasting text. States how many were added and which were not; the text stays for fixing when some were not
  await page.click("#dictImportOpen");
  expect(await page.locator("#dictImportBox").isVisible(), "D5: the import box did not open");
  await page.fill("#dictImportText", `NGX\nZyphor\n\n${"y".repeat(80)}\n`);
  await page.click("#dictImportRun");
  await settle();
  expect((await dictStatus()).startsWith("Imported 1 new word. 1 not imported:") && (await dictStatus()).includes("too long"), `D5: wrong import summary: "${await dictStatus()}"`);
  expect(same(await words(), ["NGX", "webui", "Zyphor"]), `D5: wrong list after importing: ${JSON.stringify(await words())}`);
  expect(await page.locator("#dictImportBox").isVisible(), "D5: the import box closed although one line was not imported");
  await page.screenshot({ path: join(SHOTS, "popup-D5-options-dictionary.png"), fullPage: true });

  // Import from a text file: its content appears in the text box first, so what will be imported is visible
  await page.setInputFiles("#dictImportFile", { name: "words.txt", mimeType: "text/plain", buffer: Buffer.from("﻿fluentd\r\nNGX\r\n", "utf8") });
  await settle();
  expect((await page.inputValue("#dictImportText")).includes("fluentd"), "D5: choosing a file did not show its words");
  await page.click("#dictImportRun");
  await settle();
  expect((await dictStatus()) === "Imported 1 new word.", `D5: wrong summary after importing a file: "${await dictStatus()}"`);
  expect(await page.locator("#dictImportBox").isHidden(), "D5: the import box should close after a clean import");
  expect(same(await words(), ["fluentd", "NGX", "webui", "Zyphor"]), `D5: wrong list after importing a file: ${JSON.stringify(await words())}`);

  // D6. Export: a text file, one word per line, exactly the dictionary
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.click("#dictExport")]);
  const exported = readFileSync(await download.path(), "utf8");
  expect(download.suggestedFilename() === "langfaix-dictionary.txt", `D6: wrong file name: ${download.suggestedFilename()}`);
  expect(exported === "fluentd\nNGX\nwebui\nZyphor\n", `D6: wrong exported text: ${JSON.stringify(exported)}`);

  // D7. Removing a word
  await page.locator("#dictList li", { hasText: "webui" }).locator("button").click();
  await settle();
  expect(same(await words(), ["fluentd", "NGX", "Zyphor"]) && !(await savedWords()).includes("webui"), `D7: the word was not removed: ${JSON.stringify(await words())}`);
  expect((await dictStatus()).startsWith('Removed "webui".'), `D7: wrong confirmation: "${await dictStatus()}"`);
  await context.close();
}

// D8. A dictionary saved earlier is there on reopening. Broken stored content is treated as empty, without an error.
{
  const saved = { version: 1, entries: [{ word: "Zyphor", addedAt: "2026-10-08T03:00:00.000Z" }] };
  const { page, context } = await open(OPTIONS, { ...SETTINGS, personalDictionary: saved });
  await page.waitForFunction(() => document.querySelector("#dictCount").textContent !== "", null, { timeout: 3000 });
  expect(same(await page.locator("#dictList li span").allTextContents(), ["Zyphor"]), "D8: the stored dictionary is not shown");
  await context.close();

  const broken = await open(OPTIONS, { ...SETTINGS, personalDictionary: "damaged" });
  await broken.page.waitForFunction(() => document.querySelector("#dictCount").textContent !== "", null, { timeout: 3000 });
  expect(((await broken.page.textContent("#dictCount")) ?? "") === "No words yet.", "D8: a damaged stored value should count as an empty dictionary");
  await broken.context.close();
}

expect(problems.length === 0, `page errors: ${problems.join(" | ")}`);
await browser.close();

console.log(`screenshots: ${SHOTS}`);
if (failures.length === 0) {
  console.log("RESULT: PASS (now look at the screenshots)");
} else {
  for (const failure of failures) console.log(`FAILED: ${failure}`);
  console.log("RESULT: FAIL");
}
process.exit(failures.length === 0 ? 0 : 1);
