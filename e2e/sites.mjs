// Real-world test: load the extension into a browser and try it in the kinds of places
// people really use.
//
// Every item here comes from a real "nothing happens here" report:
//   1. the TinyMCE editor. It puts the editing area in an iframe and sets
//      spellcheck="false" on it. Many admin systems use it for rich text
//   2. an iframe built with srcdoc. Its address is about:srcdoc, not a normal URL
//   3. the input box of Google Translate: a textarea, also with spellcheck="false"
//
// Each scenario checks three things:
//   a. after typing a typo, is a line drawn (counted as squiggle-coloured pixels)
//   b. with the pointer on the line, does the suggestion card appear
//   c. after clicking a suggestion, was the text really replaced
//
// These tests depend on external sites and a CDN and sometimes fail for network reasons,
// which is why they are separate from extension.mjs.
//
// Usage (in the e2e folder):
//   npm run sites -- https://your-server/api
//
// Rule checks only; no AI, no cost. Only meaningless test sentences are typed into those sites.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const API = process.argv[2];
if (!API) {
  console.error("Usage: npm run sites -- https://your-server.example.com/api");
  process.exit(2);
}

const EXTENSION = fileURLToPath(new URL("../browser-extension", import.meta.url));
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const MIN_RED_PIXELS = 30;
const SCALE = 2; // screenshot scale: 1 page pixel is 2 x 2 in the screenshot
const SENTENCE = "Please reveiw the documant befor friday.";

const profile = mkdtempSync(join(tmpdir(), "langfaix-sites-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: true,
  viewport: { width: 1000, height: 800 },
  deviceScaleFactor: SCALE,
  locale: "en-US",
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});

const results = [];
const record = (name, ok, detail) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(36)} ${detail}`);
};

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 8000 });
  const id = new URL(worker.url()).host;

  // A blank page used only to analyse screenshots.
  const counter = await context.newPage();

  // Screenshot an element to disk. Returns the number of squiggle-red pixels and the page position of the first one.
  async function shoot(page, locator, name, pad = 6) {
    const box = await locator.boundingBox();
    const clip = { x: Math.max(box.x - pad, 0), y: Math.max(box.y - pad, 0), width: box.width + pad * 2, height: box.height + pad * 2 };
    const png = await page.screenshot({ path: join(SHOTS, `sites-${name}.png`), clip });
    const found = await counter.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const drawing = canvas.getContext("2d");
      drawing.drawImage(image, 0, 0);
      const pixels = drawing.getImageData(0, 0, image.width, image.height).data;
      let red = 0;
      let first = null;
      // Only pixels almost exactly our squiggle colour #cf222e count.
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 207) <= 6 && Math.abs(pixels[i + 1] - 34) <= 8 && Math.abs(pixels[i + 2] - 46) <= 8) {
          red++;
          if (!first) first = { x: (i / 4) % image.width, y: Math.floor(i / 4 / image.width) };
        }
      }
      return { red, first };
    }, png.toString("base64"));
    return {
      red: found.red,
      // back to page coordinates
      first: found.first ? { x: clip.x + found.first.x / SCALE, y: clip.y + found.first.y / SCALE } : null,
    };
  }

  // The checks of one scenario.
  //   target     the element to screenshot (the field, or the iframe holding the editing area)
  //   readText   returns the field's current text
  async function scenario(name, page, target, readText) {
    // a. Is a line drawn
    const shot = await shoot(page, target, name);
    const underlined = shot.red >= MIN_RED_PIXELS;
    record(`${name}: underline`, underlined, `${shot.red} red pixels`);
    if (!underlined) return;

    // b. Rest the pointer just above the first line, i.e. on the word
    await page.mouse.move(shot.first.x + 4, shot.first.y - 5);
    await page.mouse.move(shot.first.x + 5, shot.first.y - 5);
    // The card must appear on the outermost page, not inside the iframe.
    const card = page.locator("langfaix-popup .card");
    await card.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    if (!(await card.isVisible())) {
      record(`${name}: card on hover`, false, "no card appeared in the top page");
      return;
    }
    const wrong = await card.locator(".old").textContent();
    const suggestion = await card.locator("button.suggestion").first().textContent();
    const cardBox = await card.boundingBox();
    const targetBox = await target.boundingBox();
    const view = page.viewportSize();
    const insideWindow = cardBox.x >= 0 && cardBox.y >= 0 && cardBox.x + cardBox.width <= view.width && cardBox.y + cardBox.height <= view.height;
    const beyondTarget = cardBox.y + cardBox.height > targetBox.y + targetBox.height;
    await page.screenshot({ path: join(SHOTS, `sites-${name}-card.png`) });
    record(
      `${name}: card on hover`,
      insideWindow,
      `"${wrong}" -> "${suggestion}"${beyondTarget ? ", card extends below the box without being cut off" : ""}`,
    );

    // c. Click the first suggestion
    await card.locator("button.suggestion").first().click();
    await page.waitForTimeout(600);
    const text = (await readText()).replaceAll(String.fromCharCode(160), " ");
    const replaced = text.includes(suggestion) && !text.includes(wrong);
    record(`${name}: one-click replace`, replaced, JSON.stringify(text.trim()));

    // d. The AI entry. This browser has no virtual key, so the click must lead to the "no key"
    // message with a button to the options page. That proves the whole path from the page to
    // the background script works, without spending anything.
    await page.waitForTimeout(2500); // wait for the re-check after the replacement
    const again = await shoot(page, target, `${name}-after-fix`);
    if (!again.first) {
      record(`${name}: AI entry`, false, "no underline left to hover");
      return;
    }
    await page.mouse.move(again.first.x + 4, again.first.y - 5);
    await page.mouse.move(again.first.x + 5, again.first.y - 5);
    await card.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    const aiEntry = card.locator("button.ai");
    if (!(await aiEntry.isVisible().catch(() => false))) {
      record(`${name}: AI entry`, false, "the card has no AI entry");
      return;
    }
    await aiEntry.click();
    await card.locator(".problem").first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    const problem = (await card.locator(".problem").first().textContent().catch(() => "")) ?? "";
    const offersOptions = await card.locator("button.accept", { hasText: "Open options" }).isVisible().catch(() => false);
    await page.screenshot({ path: join(SHOTS, `sites-${name}-ai-no-key.png`) });
    record(`${name}: AI entry`, /API key is not set/.test(problem) && offersOptions, problem || "no message appeared");
    await page.keyboard.press("Escape");

    // e. The corner badge. Drawn on the outermost page, it must lie within the field (or the
    // iframe holding the editing area). Its "improve this sentence" must also reach "no key".
    await page.waitForTimeout(400);
    const dot = page.locator("langfaix-badge .dot");
    if (!(await dot.isVisible().catch(() => false))) {
      record(`${name}: corner badge`, false, "no badge appeared in the top page");
      return;
    }
    const dotBox = await dot.boundingBox();
    const box = await target.boundingBox();
    const slack = 10; // on a short field the badge is half outside
    const inside =
      dotBox.x >= box.x && dotBox.y >= box.y && dotBox.x + dotBox.width <= box.x + box.width + slack && dotBox.y + dotBox.height <= box.y + box.height + slack;
    await dot.click();
    const menu = page.locator("langfaix-badge .menu");
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(SHOTS, `sites-${name}-badge-menu.png`) });
    const labels = await menu.locator("button.item .label").allTextContents().catch(() => []);
    await menu.locator("button.item", { hasText: "Improve this sentence" }).click({ timeout: 3000 }).catch(() => {});
    await card.locator(".problem").first().waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    const viaMenu = (await card.locator(".problem").first().textContent().catch(() => "")) ?? "";
    record(
      `${name}: corner badge`,
      inside && labels.includes("Improve this sentence") && /API key is not set/.test(viaMenu),
      `badge ${inside ? "inside" : "OUTSIDE"} the box, menu: ${labels.join(" | ") || "did not open"}${/API key is not set/.test(viaMenu) ? "" : ", picking an item did nothing"}`,
    );
    await page.keyboard.press("Escape");

    // f. The lookup box and the glossary switch on the card. The box is on the outermost page
    // while the field may be in an iframe, so a caret in the box has left the field. To
    // confirm: the card does not close because of that, typed characters do not land in the
    // field, and Esc returns the caret.
    await page.waitForTimeout(400);
    await dot.click();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    const term = menu.locator(".term");
    if (!(await term.isVisible().catch(() => false))) {
      record(`${name}: lookup in the card`, false, "the card has no lookup box");
      return;
    }
    const before = await readText();
    await term.click();
    await page.keyboard.type("policy", { delay: 40 });
    await page.waitForTimeout(1500); // much longer than the leave delay
    const stayed = (await menu.isVisible()) && (await dot.isVisible());
    // No key in this browser, so the lookup answer must be "no key": proof the request reached the background script.
    const answer = stayed ? ((await menu.locator(".lookup-status").textContent()) ?? "") : "";
    const untouched = (await readText()) === before;
    await page.screenshot({ path: join(SHOTS, `sites-${name}-lookup.png`) });

    // The switch: toggling it really saves the setting, and the card stays open.
    const toggle = menu.locator(".switch input");
    const stored = async () => (await worker.evaluate(() => chrome.storage.local.get("useGlossary"))).useGlossary;
    let switched = false;
    if (stayed) {
      await toggle.uncheck();
      await page.waitForTimeout(400);
      const off = (await stored()) === false;
      await toggle.check();
      await page.waitForTimeout(400);
      switched = off && (await stored()) === true && (await menu.isVisible());
    }

    // Esc: the card closes, the caret returns to the field, and typing continues there.
    if (stayed) await term.press("Escape");
    await page.waitForTimeout(400);
    const closed = !(await menu.isVisible());
    await page.keyboard.type("Zz", { delay: 40 });
    await page.waitForTimeout(300);
    const cursorBack = (await readText()).includes("Zz");
    const problems = [
      stayed ? "" : "the card closed while typing",
      /API key/.test(answer) ? "" : `unexpected answer ${JSON.stringify(answer)}`,
      untouched ? "" : "the typing went into the text box",
      switched ? "" : "the switch did not work",
      closed ? "" : "Escape did not close the card",
      cursorBack ? "" : "the cursor did not return to the text box",
    ].filter(Boolean);
    record(`${name}: lookup in the card`, problems.length === 0, problems.join("; ") || "stays open, switch saves, Escape returns the cursor");
  }

  // Enter the server address on the options page first.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await options.fill("#apiUrl", API);
  await options.click("#test");
  await options.waitForFunction(() => document.querySelector("#status").className.match(/ok|error/), null, { timeout: 20000 });
  const status = await options.textContent("#status");
  record("options page", /^Connected/.test(status), status);

  // ---------- 1. The real TinyMCE ----------
  try {
    const page = await context.newPage();
    await page.goto("https://httpbin.org/html", { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => {
      document.body.innerHTML = '<h3>TinyMCE</h3><textarea id="lf-tiny"></textarea>';
    });
    await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/tinymce@6.8.5/tinymce.min.js" });
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          // The editing area is deliberately low, as in many admin systems. The card is taller and must be drawn outside the iframe.
          // eslint-disable-next-line no-undef
          tinymce.init({ selector: "#lf-tiny", height: 170, menubar: false, promotion: false, branding: false }).then(resolve, reject);
        }),
    );
    const frame = page.frameLocator("#lf-tiny_ifr");
    await frame.locator("body").click();
    await page.keyboard.type(SENTENCE, { delay: 15 });
    await page.waitForTimeout(3500);
    // eslint-disable-next-line no-undef
    await scenario("tinymce", page, page.locator("#lf-tiny_ifr"), () => page.evaluate(() => tinymce.activeEditor.getContent({ format: "text" })));
    await page.close();
  } catch (error) {
    record("tinymce", false, `could not run: ${String(error).split("\n")[0]}`);
  }

  // ---------- 2. srcdoc iframe ----------
  try {
    const page = await context.newPage();
    await page.goto("https://httpbin.org/html", { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => {
      document.body.innerHTML = "<h3>srcdoc iframe</h3>";
      const frame = document.createElement("iframe");
      frame.id = "lf-srcdoc";
      frame.style.cssText = "width: 600px; height: 90px; border: 3px solid #888; margin-left: 40px";
      frame.srcdoc =
        '<!DOCTYPE html><html><head><style>body{font:16px Arial;margin:10px}</style></head>' +
        '<body id="tinymce" class="mce-content-body" contenteditable="true" spellcheck="false"><p><br></p></body></html>';
      document.body.append(frame);
    });
    await page.waitForTimeout(800);
    const frame = page.frameLocator("#lf-srcdoc");
    await frame.locator("body").click();
    await page.keyboard.type(SENTENCE, { delay: 15 });
    await page.waitForTimeout(3500);
    await scenario("srcdoc-iframe", page, page.locator("#lf-srcdoc"), () => frame.locator("body").innerText());
    await page.close();
  } catch (error) {
    record("srcdoc-iframe", false, `could not run: ${String(error).split("\n")[0]}`);
  }

  // ---------- 3. Google Translate ----------
  try {
    const page = await context.newPage();
    await page.goto("https://translate.google.com/?sl=en&tl=es&op=translate", { waitUntil: "domcontentloaded", timeout: 40000 });
    // Some regions show a consent page first.
    if (/consent\.google/.test(page.url())) {
      await page.locator('button:has-text("Reject all"), button:has-text("Accept all")').first().click({ timeout: 10000 });
      await page.waitForURL(/translate\.google/, { timeout: 20000 });
    }
    const box = page.locator("textarea").first();
    await box.waitFor({ state: "visible", timeout: 20000 });
    await box.click();
    await page.waitForTimeout(500); // this page drops the first character right after the click: wait before typing
    await page.keyboard.type(SENTENCE, { delay: 15 });
    await page.waitForTimeout(3500);
    await scenario("google-translate", page, box, () => box.inputValue());
    await page.close();
  } catch (error) {
    record("google-translate", false, `could not run: ${String(error).split("\n")[0]}`);
  }

  // ---------- 4. A real AI request with an invalid key ----------
  // In the first three the key is empty and the request is stopped inside the extension.
  // Here a made-up key lets the request go all the way: extension > our server > LiteLLM.
  // LiteLLM does not know the key and refuses before reaching the model provider: no cost.
  try {
    await options.bringToFront();
    await options.fill("#apiKey", "sk-not-a-real-key-for-testing");
    await options.click("#save");
    await options.waitForFunction(() => /Saved/.test(document.querySelector("#status").textContent), null, { timeout: 5000 });

    const page = await context.newPage();
    await page.goto("https://httpbin.org/forms/post", { waitUntil: "load", timeout: 30000 });
    const area = page.locator("textarea[name=comments]");
    await area.click();
    await page.keyboard.type("Please leeve it here.", { delay: 15 });
    await page.waitForTimeout(3500);
    const shot = await shoot(page, area, "rejected-key");
    await page.mouse.move(shot.first.x + 4, shot.first.y - 5);
    await page.mouse.move(shot.first.x + 5, shot.first.y - 5);
    const card = page.locator("langfaix-popup .card");
    await card.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
    await card.locator("button.ai").click();
    await card.locator(".problem").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const problem = (await card.locator(".problem").first().textContent().catch(() => "")) ?? "";
    const offersOptions = await card.locator("button.accept", { hasText: "Open options" }).isVisible().catch(() => false);
    await page.screenshot({ path: join(SHOTS, "sites-rejected-key-card.png") });
    record("real AI request with a made-up key", /API key was rejected/.test(problem) && offersOptions, problem || "no message appeared");
    await page.close();
  } catch (error) {
    record("real AI request with a made-up key", false, `could not run: ${String(error).split("\n")[0]}`);
  }
} finally {
  await context.close();
}

const passed = results.every(([, ok]) => ok);
console.log(`screenshots: ${SHOTS}`);
console.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(passed ? 0 : 1);
