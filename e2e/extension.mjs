// End-to-end test: load the extension into a real browser and walk the paths a user would.
//
// What it does:
//   1. uses the Edge installed on this computer (Chrome as a fallback), headless, with a
//      temporary profile, so your own browser, bookmarks and sign-ins are untouched
//   2. opens the options page, enters the server address, presses Save and test
//   3. opens the popup page, checks a sentence, clicks a squiggle
//   4. opens the extension's own test page and looks at the squiggles on a large-font field
//   5. opens a real site and types into a textarea, an input and a rich-text area, to
//      confirm the script injects itself and draws lines, and that a "customer name"
//      input is not checked
// Every step takes a screenshot into shots/.
//
// Whether a line was drawn is decided by counting red pixels in the screenshot, not just
// by the absence of errors.
//
// Usage (in the e2e folder):
//   npm install          first time only
//   npm run extension -- https://your-server/api
//
// It really contacts the server, but only for rule checks; no AI, no cost.
//
// Note: branded Chrome 137 and later no longer loads extensions from the command line, so
// Edge is tried first.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const API = process.argv[2];
if (!API) {
  console.error("Usage: npm run extension -- https://your-server.example.com/api");
  process.exit(2);
}

// Normally the browser-extension folder. packed.mjs points this variable at the unpacked zip.
const EXTENSION = process.env.LANGFAIX_EXTENSION_DIR || fileURLToPath(new URL("../browser-extension", import.meta.url));
if (process.env.LANGFAIX_EXTENSION_DIR) console.log(`extension folder: ${EXTENSION}`);
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

// Where lines are drawn there are at least this many red pixels; without lines, 0.
const MIN_RED_PIXELS = 30;

async function run(channel) {
  const profile = mkdtempSync(join(tmpdir(), "langfaix-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel,
    headless: true,
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    // Once loaded, the extension's service worker appears. If it never does, this browser does not allow loading extensions this way.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 8000 }).catch(() => null);
    if (!worker) return { channel, loaded: false };

    const id = new URL(worker.url()).host;
    const problems = [];
    const watch = (page, label) => page.on("pageerror", (error) => problems.push(`${label}: ${error}`));

    // A blank page used only to count red pixels in screenshots.
    const counter = await context.newPage();

    // Screenshot an element to disk and return how many squiggle-red pixels it has.
    async function shoot(page, locator, name, pad = 8) {
      const box = await locator.boundingBox();
      const png = await page.screenshot({
        path: join(SHOTS, `extension-${name}.png`),
        clip: { x: Math.max(box.x - pad, 0), y: Math.max(box.y - pad, 0), width: box.width + pad * 2, height: box.height + pad * 2 },
      });
      return counter.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const drawing = canvas.getContext("2d");
        drawing.drawImage(image, 0, 0);
        const pixels = drawing.getImageData(0, 0, image.width, image.height).data;
        let red = 0;
        // Our squiggle colour is #cf222e (207, 34, 46). Only pixels almost exactly that colour
        // count. Not "anything reddish": the browser's own spellcheck draws pure red (255, 0, 0).
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.abs(pixels[i] - 207) <= 6 && Math.abs(pixels[i + 1] - 34) <= 8 && Math.abs(pixels[i + 2] - 46) <= 8) red++;
        }
        return red;
      }, png.toString("base64"));
    }

    // 1. Options page
    const options = await context.newPage();
    watch(options, "options page");
    await options.goto(`chrome-extension://${id}/options/options.html`);
    await options.fill("#apiUrl", API);
    await options.click("#test");
    await options.waitForFunction(() => document.querySelector("#status").className.match(/ok|error/), null, { timeout: 20000 });
    const optionsStatus = await options.textContent("#status");
    await options.screenshot({ path: join(SHOTS, "extension-options.png") });

    // 2. Popup page (opened as a normal page)
    const popup = await context.newPage();
    watch(popup, "popup");
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    // The popup opens on lookup. This browser has no key set, so lookup must say so instead of doing nothing.
    await popup.fill("#term", "policy");
    await popup.waitForFunction(() => document.querySelector("#lookup-status").textContent.trim() !== "", null, { timeout: 8000 }).catch(() => {});
    const lookupStatus = ((await popup.textContent("#lookup-status")) ?? "").trim();
    // Quick check is on the other tab.
    await popup.click("#tab-check");
    await popup.fill("#text", "This are a test sentense.");
    await popup.click("#check");
    // Wait until the popup has a verdict: issues found, or an error shown.
    await popup
      .waitForFunction(
        () => {
          const status = document.querySelector("#status");
          return /found|error/i.test(status.textContent + status.className);
        },
        null,
        { timeout: 20000 },
      )
      .catch(() => {});
    const popupStatus = await popup.textContent("#status");
    if (await popup.locator("#preview .err").count()) await popup.locator("#preview .err").last().click();
    await popup.screenshot({ path: join(SHOTS, "extension-popup.png") });

    // 3. The extension's own test page
    const testPage = await context.newPage();
    watch(testPage, "test page");
    await testPage.goto(`chrome-extension://${id}/test/fields.html`);
    await testPage.locator("#big").click({ position: { x: 5, y: 5 } });
    await testPage.waitForTimeout(2500);
    const testPageRed = await shoot(testPage, testPage.locator("#big"), "testpage-big");
    // Two errors in this sentence, so it should also have a lavender hint line (free; no AI).
    const testPageHints = await testPage.evaluate(() => window.__langfaix.inspect().filter((mark) => mark.kind === "hint").length);
    // The badge at the bottom right should show 2 issues for this field.
    const testPageBadge = (await testPage.locator("langfaix-badge .dot").textContent({ timeout: 2000 }).catch(() => "")) ?? "";

    // 3b. The cost estimate, through the real background script and chrome.storage.local.
    // No estimate before any AI use; with two numbers in the record, it is their average.
    const estimate = await testPage.evaluate(async () => {
      const before = await chrome.runtime.sendMessage({ type: "estimate" });
      await chrome.storage.local.set({ aiStats: { sentences: 4, usd: 0.0012 } });
      const after = await chrome.runtime.sendMessage({ type: "estimate" });
      await chrome.storage.local.remove("aiStats");
      return { before: before?.data?.usd ?? null, after: after?.data?.usd ?? null };
    });

    // 3c. Personal dictionary, through the real background script and chrome.storage.local:
    // click Add to dictionary on the card and reload; the word must still not be reported
    // while other typos are. Surviving the reload proves the word is stored in the browser.
    const ruleWords = () => testPage.evaluate(() => window.__langfaix.inspect().filter((mark) => mark.kind === "rule").map((mark) => mark.text));
    const dictionary = { before: await ruleWords(), added: false, afterReload: [], stored: [], listed: [] };
    const target = await testPage.evaluate(() => window.__langfaix.inspect().find((mark) => mark.text === "trafic") ?? null);
    if (target) {
      await testPage.mouse.move((target.left + target.right) / 2 - 2, (target.top + target.bottom) / 2);
      await testPage.mouse.move((target.left + target.right) / 2, (target.top + target.bottom) / 2);
      const addWord = testPage.locator("langfaix-popup button.add-word");
      await addWord.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      if (await addWord.isVisible().catch(() => false)) {
        await addWord.click();
        dictionary.added = true;
        await testPage.waitForTimeout(600);
        await testPage.reload();
        await testPage.locator("#big").click({ position: { x: 5, y: 5 } });
        await testPage.waitForTimeout(2500);
        dictionary.afterReload = await ruleWords();
        dictionary.stored = await testPage.evaluate(async () =>
          ((await chrome.storage.local.get("personalDictionary")).personalDictionary?.entries ?? []).map((entry) => entry.word),
        );
        // It should be in the list on the options page too.
        await options.reload();
        await options.waitForFunction(() => document.querySelector("#dictCount").textContent !== "", null, { timeout: 5000 }).catch(() => {});
        dictionary.listed = await options.locator("#dictList li span").allTextContents();
      }
    }

    // 4. A real site
    const real = await context.newPage();
    watch(real, "real site");
    await real.goto("https://httpbin.org/forms/post", { waitUntil: "load", timeout: 30000 });

    // 4a. The site's own textarea
    const area = real.locator("textarea[name=comments]");
    await area.click();
    await real.keyboard.type("This are important. Please leeve it at the door.", { delay: 15 });
    await real.waitForTimeout(3000);
    const textareaRed = await shoot(real, area, "real-site-textarea");

    // 4b. The site's own "customer name" input: personal data, must not be checked
    const customerName = real.locator("input[name=custname]");
    await customerName.click();
    await real.keyboard.type("Jhon Smiht the thrid", { delay: 15 });
    await real.waitForTimeout(2500);
    const nameRed = await shoot(real, customerName, "real-site-name-field");
    const nameOverlay = await real.evaluate(() => Boolean(document.querySelector("langfaix-overlay")));

    // 4c. The site has no single-line input or rich-text area suited to sentences, so two are
    // added. They are ordinary elements the extension knows nothing about, as on any real site.
    await real.evaluate(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<p><input id="lf-subject" name="subject" style="width: 420px; font-size: 16px" /></p>' +
          '<div id="lf-rich" contenteditable="true" style="width: 420px; min-height: 60px; padding: 8px; border: 1px solid #888; font: 16px Arial"><p>Hello,</p><p><br></p></div>',
      );
    });
    const subject = real.locator("#lf-subject");
    await subject.click();
    await real.keyboard.type("Problem with the secend printer", { delay: 15 });
    await real.waitForTimeout(3000);
    const inputRed = await shoot(real, subject, "real-site-input");

    const rich = real.locator("#lf-rich");
    await rich.locator("p").last().click();
    await real.keyboard.type("Please reveiw the documant today.", { delay: 15 });
    await real.waitForTimeout(3000);
    const richRed = await shoot(real, rich, "real-site-rich");
    const richHighlights = await real.evaluate(() => CSS.highlights.get("langfaix-error")?.size ?? 0);

    return {
      channel,
      loaded: true,
      optionsStatus,
      popupStatus,
      lookupStatus,
      testPageRed,
      testPageHints,
      testPageBadge,
      estimate,
      dictionary,
      textareaRed,
      nameRed,
      nameOverlay,
      inputRed,
      richRed,
      richHighlights,
      problems,
    };
  } finally {
    await context.close();
  }
}

let passed = false;
for (const channel of ["msedge", "chrome"]) {
  let result;
  try {
    result = await run(channel);
  } catch (error) {
    console.log(`${channel}: could not run (${String(error).split("\n")[0]})`);
    continue;
  }
  if (!result.loaded) {
    console.log(`${channel}: the browser did not load the extension, trying the next one`);
    continue;
  }

  const underlined = (red) => (red >= MIN_RED_PIXELS ? `underlined (${red} red pixels)` : `NOT underlined (${red} red pixels)`);
  const checks = [
    ["options page", /^Connected/.test(result.optionsStatus), result.optionsStatus],
    ["popup", /issues? found/.test(result.popupStatus), result.popupStatus],
    ["popup, glossary lookup without a key", /API key is not set/.test(result.lookupStatus), result.lookupStatus || "no message appeared"],
    ["test page, big textarea", result.testPageRed >= MIN_RED_PIXELS, underlined(result.testPageRed)],
    ["test page, free AI hint", result.testPageHints > 0, result.testPageHints > 0 ? "purple hint line drawn" : "NO hint line"],
    ["test page, corner badge", result.testPageBadge === "2", result.testPageBadge ? `shows ${result.testPageBadge}` : "NO badge"],
    [
      "personal dictionary",
      result.dictionary.added &&
        result.dictionary.before.includes("trafic") &&
        !result.dictionary.afterReload.includes("trafic") &&
        result.dictionary.afterReload.includes("dont") &&
        result.dictionary.stored.join() === "trafic" &&
        result.dictionary.listed.join() === "trafic",
      result.dictionary.added
        ? `after a reload still underlined: ${result.dictionary.afterReload.join(", ") || "nothing"}; stored: ${result.dictionary.stored.join(", ") || "nothing"}; options page lists: ${result.dictionary.listed.join(", ") || "nothing"}`
        : "the card had no Add to dictionary button",
    ],
    [
      "cost estimate",
      result.estimate.before === null && Math.abs((result.estimate.after ?? 0) - 0.0003) < 1e-9,
      `before any AI call: ${result.estimate.before}, with a record: ${result.estimate.after}`,
    ],
    ["real site, textarea", result.textareaRed >= MIN_RED_PIXELS, underlined(result.textareaRed)],
    [
      "real site, name field",
      result.nameRed === 0 && !result.nameOverlay,
      result.nameRed === 0 && !result.nameOverlay ? "skipped, as it should be" : `CHECKED, must not be (${result.nameRed} red pixels)`,
    ],
    ["real site, subject input", result.inputRed >= MIN_RED_PIXELS, underlined(result.inputRed)],
    [
      "real site, rich editor",
      result.richRed >= MIN_RED_PIXELS && result.richHighlights > 0,
      `${underlined(result.richRed)}, ${result.richHighlights} highlight(s)`,
    ],
    ["page errors", result.problems.length === 0, result.problems.length ? result.problems.join(" | ") : "none"],
  ];

  console.log(`browser: ${result.channel}`);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(26)} ${detail}`);
  console.log(`screenshots: ${SHOTS}`);
  passed = checks.every(([, ok]) => ok);
  break;
}

console.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(passed ? 0 : 1);
