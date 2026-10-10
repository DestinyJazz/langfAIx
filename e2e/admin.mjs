// Browser test of the glossary admin page.
//
// What it does:
//   1. starts a fake LiteLLM (it only identifies keys) and a fake LanguageTool (reports
//      nothing) on this computer
//   2. starts the backend as a plain process (not a container) with a temporary SQLite file
//   3. opens the admin page in a headless browser and walks through: sign-in, roles,
//      adding, duplicate checks, search, editing, import (Excel, paste, unrecognised
//      columns), export, granting a role, the change log, deleting, passwords
// Every step takes a screenshot into shots/, named admin-*.
//
// No server is contacted, no real key is needed, nothing is spent.
// The backend runs with ROOT_PATH=/api here while /admin/ is opened directly, as when a
// reverse proxy strips /api before forwarding.
//
// Usage (in the e2e folder):
//   npm run admin

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const BACKEND = fileURLToPath(new URL("../backend/", import.meta.url));
const PYTHON = join(BACKEND, ".venv", "Scripts", "python.exe");
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const WORK = mkdtempSync(join(tmpdir(), "langfaix-admin-"));

// Two fake keys: root is the admin named in the settings, amy an ordinary user.
const KEYS = { "sk-root": "root", "sk-amy": "amy" };
// The backend's own LiteLLM admin key, used to look up whose the two keys above are.
const ADMIN_KEY = "sk-master-for-tests";
const ALIAS_BY_HASH = Object.fromEntries(Object.entries(KEYS).map(([key, alias]) => [createHash("sha256").update(key).digest("hex"), alias]));

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

// ---------- Fake LiteLLM and LanguageTool ----------

const fake = createServer((request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  request.resume(); // drain the request body; its content does not matter
  if (request.url.startsWith("/key/info")) {
    // Like a real LiteLLM:
    //   the admin key can look up any key by hash; an unknown one gives 404
    //   a user's key may only call models; asking about itself gives 403
    const caller = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const wanted = new URL(request.url, "http://x").searchParams.get("key");
    if (caller === ADMIN_KEY) {
      const alias = ALIAS_BY_HASH[wanted];
      if (alias) reply(200, { key: wanted, info: { key_alias: alias, status: "active", blocked: null } });
      else reply(404, { error: { message: "Key not found in database", type: "not_found_error", code: "404" } });
    } else if (KEYS[caller]) {
      reply(403, { detail: "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']. Tried to call route: /key/info" });
    } else {
      reply(401, { error: { message: "Authentication Error, Invalid proxy server token passed.", type: "token_not_found_in_db", code: "401" } });
    }
  } else if (request.url.startsWith("/v2/check")) {
    reply(200, { language: { code: "en-US" }, matches: [] });
  } else {
    reply(404, { error: "not found" });
  }
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const fakePort = await listen(fake);

// Find a free port for the backend.
const probe = createServer();
const port = await listen(probe);
await new Promise((resolve) => probe.close(resolve));

// ---------- Start the backend ----------

const database = join(WORK, "glossary.db").replaceAll("\\", "/");
const backend = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: BACKEND,
  env: {
    ...process.env,
    LITELLM_URL: `http://127.0.0.1:${fakePort}`,
    LANGUAGETOOL_URL: `http://127.0.0.1:${fakePort}`,
    DATABASE_URL: `sqlite+pysqlite:///${database}`,
    GLOSSARY_ADMINS: "root",
    LITELLM_ADMIN_KEY: ADMIN_KEY,
    ROOT_PATH: "/api",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let backendLog = "";
backend.stdout.on("data", (chunk) => (backendLog += chunk));
backend.stderr.on("data", (chunk) => (backendLog += chunk));

const BASE = `http://127.0.0.1:${port}`;
async function waitForBackend() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the backend did not start:\n${backendLog}`);
}

// Make a real Excel file, with Chinese content, using the backend's own Python environment.
function makeWorkbook(name, rows) {
  const path = join(WORK, name);
  const code = ["import json, sys", "from openpyxl import Workbook", "book = Workbook()", "[book.active.append(row) for row in json.loads(sys.argv[2])]", "book.save(sys.argv[1])"].join("\n");
  execFileSync(PYTHON, ["-c", code, path, JSON.stringify(rows)]);
  return path;
}

let browser;
try {
  const health = await waitForBackend();
  expect(health.glossary_storage === "ok", `the glossary database is not ready: ${JSON.stringify(health)}`);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("dialog", (dialog) => dialog.accept()); // confirm dialogs before deleting: always OK

  const shot = (name) => page.screenshot({ path: join(SHOTS, `admin-${name}.png`) });
  const text = async (selector) => ((await page.locator(selector).first().textContent().catch(() => "")) ?? "").trim();
  const englishColumn = () => page.locator("#terms-table tbody td.en").allTextContents();
  const passwordDialog = page.locator("#password-dialog[open]");
  // Sign in with a key. The sign-in page may show name-and-password; switch to the key form
  // first. After sign-in the set-password dialog opens by itself; unless dismiss is false it
  // is closed here with Not now.
  const signIn = async (key, { dismiss = true } = {}) => {
    if (await page.locator("#login-form").isHidden()) await page.click("#use-key");
    await page.fill("#key", key);
    await page.click("#login-form button[type=submit]");
    await Promise.race([
      passwordDialog.waitFor({ state: "visible", timeout: 5000 }),
      page.waitForFunction(() => document.querySelector("#login-status").classList.contains("error"), null, { timeout: 5000 }),
    ]).catch(() => {});
    if (dismiss && (await passwordDialog.isVisible())) await page.click("#pw-skip");
  };
  // Sign in with name and password.
  const signInWithPassword = async (name, password, { keep = true } = {}) => {
    if (await page.locator("#password-form").isHidden()) await page.click("#use-password");
    await page.fill("#login-name", name);
    await page.fill("#login-password", password);
    await page.locator("#login-keep").setChecked(keep);
    await page.click("#password-form button[type=submit]");
  };
  // What the browser keeps now.
  const kept = () =>
    page.evaluate(() => ({
      key: sessionStorage.getItem("langfaix-glossary-key"),
      tab: sessionStorage.getItem("langfaix-glossary-session"),
      computer: localStorage.getItem("langfaix-glossary-session"),
    }));
  // Ask the backend directly whether it still accepts a session token.
  const tokenStatus = async (token) => (await fetch(`${BASE}/glossary/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
  const waitForStatus = (selector, fragment) =>
    page.waitForFunction(([s, f]) => document.querySelector(s).textContent.includes(f), [selector, fragment], { timeout: 5000 }).catch(() => {});

  // ---------- 1. Sign-in ----------

  // Opens without the trailing slash too.
  await page.goto(`${BASE}/admin`);
  expect(page.url() === `${BASE}/admin/`, `/admin did not redirect to /admin/: ${page.url()}`);
  expect(await page.locator("#view-login").isVisible(), "1: the sign-in form is not shown");
  // Nobody has set a password in this browser yet, so the key form shows first.
  expect((await page.locator("#login-form").isVisible()) && (await page.locator("#password-form").isHidden()), "1: a first visit should ask for the API key");
  await shot("01-sign-in");

  await signIn("sk-nobody");
  await page.waitForFunction(() => document.querySelector("#login-status").textContent.includes("rejected"), null, { timeout: 5000 }).catch(() => {});
  expect((await text("#login-status")).includes("rejected"), `1: a wrong key should be refused with a reason, got "${await text("#login-status")}"`);
  expect(await page.locator("#view-terms").isHidden(), "1: a wrong key got in");

  // ---------- 2. An ordinary user: read only ----------

  // After a key sign-in the set-password dialog opens by itself. This time: Not now.
  await signIn("sk-amy", { dismiss: false });
  expect(await passwordDialog.isVisible(), "2: signing in with the key should offer to create a password");
  expect((await text("#pw-title")) === "Create a password", `2: wrong dialog title: "${await text("#pw-title")}"`);
  expect((await page.inputValue("#pw-login")) === "amy", "2: the name should start as the key alias");
  expect(await page.locator("#pw-current-row").isHidden(), "2: someone who signed in with the key must not be asked for a current password");
  await shot("02a-create-password-offer");
  await page.click("#pw-skip");
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 });
  expect(await passwordDialog.isHidden(), "2: Not now did not close the dialog");
  expect((await text("#open-password")) === "Set a password", `2: the header should offer to set a password, shows "${await text("#open-password")}"`);
  // Reload after Not now: it does not open again.
  await page.reload();
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(400);
  expect(await passwordDialog.isHidden(), "2: the dialog came back after Not now and a reload");
  expect((await text("#who-role")) === "viewer", `2: amy should be a viewer, is "${await text("#who-role")}"`);
  expect(await page.locator("#viewer-note").isVisible(), "2: the viewer is not told how to get edit rights");
  expect((await text("#viewer-note")).includes("amy"), "2: the note does not show who is signed in");
  expect(await page.locator("#add-term").isHidden(), "2: a viewer sees the Add term button");
  expect(await page.locator('.tab[data-view="import"]').isHidden(), "2: a viewer sees the Import tab");
  expect(await page.locator('.tab[data-view="people"]').isHidden(), "2: a viewer sees the People tab");
  expect((await text("#terms-table tbody")).includes("The glossary is empty"), "2: an empty glossary should say so");
  await shot("02-viewer");
  await page.click("#sign-out");

  // ---------- 3. The admin: adding ----------

  await signIn("sk-root");
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 });
  expect((await text("#who-role")) === "admin", `3: root should be an admin, is "${await text("#who-role")}"`);
  expect(await page.locator("#add-term").isVisible(), "3: the admin has no Add term button");

  await page.click("#add-term");
  await page.fill("#term-zh", "网页管理界面");
  await page.fill("#term-en", "WebUI");
  await page.fill("#term-category", "Feature");
  await page.fill("#term-variants", "Web UI\nweb-ui");
  await page.fill("#term-note", "The main page of the device.");
  await shot("03-add-dialog");
  await page.click("#term-save");
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 });
  expect(JSON.stringify(await englishColumn()) === '["WebUI"]', `3: the new term is not in the table: ${JSON.stringify(await englishColumn())}`);
  expect((await text("#terms-table tbody td.zh")) === "网页管理界面", "3: the Chinese term is not shown");
  expect((await page.locator("#terms-table tbody .wrong").allTextContents()).join("|") === "Web UI|web-ui", "3: the wrong forms are not shown");
  expect((await text("#terms-status")).includes("in effect now"), "3: no confirmation after saving");

  // A duplicate row: the dialog stays and gives the reason.
  await page.click("#add-term");
  await page.fill("#term-zh", "网页管理界面");
  await page.fill("#term-en", "webui");
  await page.click("#term-save");
  await page.waitForFunction(() => document.querySelector("#term-status").textContent !== "", null, { timeout: 5000 }).catch(() => {});
  expect((await text("#term-status")).includes("already exists"), `3: a duplicate should be refused with a reason, got "${await text("#term-status")}"`);
  expect(await page.locator("#term-dialog").evaluate((dialog) => dialog.open), "3: the dialog closed although saving failed");
  await shot("04-duplicate-refused");
  await page.click("#term-cancel");

  // A second English term for the same Chinese term, each with its own applies-to.
  for (const [en, applies] of [
    ["Archiving Center", "before 3.1.60"],
    ["Archive Center", "3.1.60 and later"],
  ]) {
    await page.click("#add-term");
    await page.fill("#term-zh", "归档中心");
    await page.fill("#term-en", en);
    await page.fill("#term-applies", applies);
    await page.click("#term-save");
    await page.waitForFunction((term) => [...document.querySelectorAll("#terms-table td.en")].some((cell) => cell.textContent === term), en, { timeout: 5000 }).catch(() => {});
  }
  expect((await englishColumn()).length === 3, `3: expected 3 rows, got ${JSON.stringify(await englishColumn())}`);

  // ---------- 4. Search and filters ----------

  await page.fill("#search", "归档");
  expect(JSON.stringify(await englishColumn()) === '["Archive Center","Archiving Center"]', `4: searching Chinese: ${JSON.stringify(await englishColumn())}`);
  expect((await text("#count")) === "2 of 3 rows", `4: wrong count: "${await text("#count")}"`);
  await shot("05-search-chinese");
  await page.fill("#search", "web ui"); // found by a wrong form too
  expect(JSON.stringify(await englishColumn()) === '["WebUI"]', `4: searching a wrong form: ${JSON.stringify(await englishColumn())}`);
  await page.fill("#search", "");
  await page.selectOption("#filter-applies", "3.1.60 and later");
  expect(JSON.stringify(await englishColumn()) === '["Archive Center"]', `4: filtering by version: ${JSON.stringify(await englishColumn())}`);
  await page.selectOption("#filter-applies", "");

  // ---------- 5. Editing ----------

  await page.locator("#terms-table tbody tr", { hasText: "WebUI" }).locator("button.edit").click();
  expect((await page.inputValue("#term-variants")) === "Web UI\nweb-ui", "5: the dialog did not load the wrong forms");
  await page.fill("#term-note", "Changed note.");
  await page.click("#term-save");
  await page.waitForFunction(() => document.querySelector("#terms-table").textContent.includes("Changed note."), null, { timeout: 5000 }).catch(() => {});
  expect((await text("#terms-table tbody")).includes("Changed note."), "5: the change is not shown");

  // ---------- 6. Effective at once: ask the backend's /check directly ----------

  const check = await fetch(`${BASE}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Open the Web UI and go to 归档中心 to continue." }),
  }).then((response) => response.json());
  const found = check.matches.map((match) => `${match.text} -> ${match.replacements.join(" / ")}`);
  expect(
    JSON.stringify(found) === '["Web UI -> WebUI","归档中心 -> Archiving Center / Archive Center"]',
    `6: /check does not use the glossary as it is now: ${JSON.stringify(found)}`,
  );

  // ---------- 7. Excel import ----------

  const sheet = makeWorkbook("glossary.xlsx", [
    ["中文", "英文", "分类", "适用版本", "错误写法", "备注"],
    ["网页管理界面", "WebUI", "Portal", "", "Web UI; web-ui", "Changed note."], // exists, different category
    ["策略", "Policies", "Feature", "", "Policys", ""], // new
    ["企业版", "Enterprise Edition", "Version", "", "", ""], // new
    ["没有英文的一行", "", "", "", "", ""], // has a problem
  ]);
  await page.click('.tab[data-view="import"]');
  await page.setInputFiles("#import-file", sheet);
  await page.click("#import-preview");
  await page.locator("#import-result").waitFor({ state: "visible", timeout: 8000 });
  const chips = await page.locator("#import-counts .chip").allTextContents();
  expect(JSON.stringify(chips) === '["2 new","1 will change","1 problem"]', `7: wrong preview counts: ${JSON.stringify(chips)}`);
  expect((await text("#import-table tbody")).includes("The English term is required."), "7: the problem row does not say why");
  expect((await text("#import-confirm")) === "Import 3 rows", `7: wrong button: "${await text("#import-confirm")}"`);
  await shot("06-import-preview");
  await page.click("#import-confirm");
  await page.waitForFunction(() => document.querySelector("#import-status").textContent.includes("Imported"), null, { timeout: 8000 }).catch(() => {});
  expect((await text("#import-status")) === "Imported: 2 new, 1 changed. They are in effect now.", `7: wrong result: "${await text("#import-status")}"`);

  await page.click('.tab[data-view="terms"]');
  await page.waitForFunction(() => document.querySelectorAll("#terms-table tbody tr[data-id]").length === 5, null, { timeout: 5000 }).catch(() => {});
  expect((await englishColumn()).length === 5, `7: expected 5 rows after the import, got ${JSON.stringify(await englishColumn())}`);
  expect((await text("#terms-table tbody")).includes("Portal"), "7: the existing row was not updated by the import");
  await shot("07-after-import");

  // ---------- 8. Paste, and a sheet with unrecognised columns ----------

  await page.click('.tab[data-view="import"]');
  await page.fill("#import-text", "中文\tEnglish\n网关\tZyphor Gateway\n");
  await page.click("#import-preview");
  await page.locator("#import-result").waitFor({ state: "visible", timeout: 8000 });
  expect((await text("#import-confirm")) === "Import 1 rows", `8: pasted text: "${await text("#import-confirm")}"`);
  await page.fill("#import-text", "");

  // Unknown headers and both columns Chinese: the user has to map them.
  const odd = makeWorkbook("odd.xlsx", [
    ["名称", "叫法"],
    ["调度器", "Scheduler"],
    ["日志", "Log"],
  ]);
  await page.setInputFiles("#import-file", odd);
  await page.click("#import-preview");
  await page.waitForFunction(() => document.querySelector("#import-table").textContent.includes("Scheduler"), null, { timeout: 8000 }).catch(() => {});
  // The first row was taken as data and its "English" cell is Chinese, so that row is an error.
  expect((await text("#import-table tbody")).includes("contains Chinese characters"), "8: a Chinese word in the English column was not caught");
  await page.locator("#import-columns summary").click();
  await page.check("#import-header");
  await page.selectOption('#import-mapping select[data-field="zh"]', "0");
  await page.selectOption('#import-mapping select[data-field="en"]', "1");
  await shot("08-import-columns");
  await page.click("#import-reread");
  await page.waitForFunction(() => document.querySelector("#import-confirm").textContent === "Import 2 rows", null, { timeout: 8000 }).catch(() => {});
  expect((await text("#import-confirm")) === "Import 2 rows", `8: after fixing the columns: "${await text("#import-confirm")}"`);
  await page.click("#import-confirm");
  await page.waitForFunction(() => document.querySelector("#import-status").textContent.includes("Imported"), null, { timeout: 8000 }).catch(() => {});

  // ---------- 9. Export ----------

  await page.click('.tab[data-view="terms"]');
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 });
  for (const [button, name] of [
    ["#export-xlsx", "glossary.xlsx"],
    ["#export-csv", "glossary.csv"],
  ]) {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), page.click(button)]);
    const saved = join(WORK, `exported-${name}`);
    await download.saveAs(saved);
    expect(download.suggestedFilename() === name, `9: wrong file name: ${download.suggestedFilename()}`);
    expect(statSync(saved).size > 200, `9: the exported ${name} is almost empty`);
  }

  // ---------- 10. Granting a role ----------

  await page.click('.tab[data-view="people"]');
  await page.locator("#people-table tbody tr").first().waitFor({ state: "visible", timeout: 5000 });
  const amyRow = page.locator('#people-table tbody tr[data-alias="amy"]');
  const rootRow = page.locator('#people-table tbody tr[data-alias="root"]');
  expect((await amyRow.locator("select").inputValue()) === "viewer", "10: amy should start as a viewer");
  expect(await rootRow.locator("select").isDisabled(), "10: an admin from the server setting should not be changeable here");
  await amyRow.locator("select").selectOption("editor");
  await page.waitForFunction(() => document.querySelector("#people-status").textContent.includes("editor"), null, { timeout: 5000 }).catch(() => {});
  expect((await text("#people-status")) === "amy is now editor.", `10: wrong status: "${await text("#people-status")}"`);
  await shot("09-people");

  // ---------- 11. Change log ----------

  await page.click('.tab[data-view="history"]');
  await page.locator("#history-table tbody tr").first().waitFor({ state: "visible", timeout: 5000 });
  const history = await text("#history-table tbody");
  for (const expected of ["amy is now editor", "Imported 2 new and 1 changed rows", "Changed WebUI", "Added WebUI"]) {
    expect(history.includes(expected), `11: the history does not mention "${expected}"`);
  }
  await shot("10-history");

  // ---------- 12. The user can edit now, deleting included ----------

  await page.click("#sign-out");
  await signIn("sk-amy");
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 });
  expect((await text("#who-role")) === "editor", `12: amy should now be an editor, is "${await text("#who-role")}"`);
  expect(await page.locator("#add-term").isVisible(), "12: an editor has no Add term button");
  expect(await page.locator('.tab[data-view="people"]').isHidden(), "12: an editor sees the People tab");
  const before = (await englishColumn()).length;
  await page.locator("#terms-table tbody tr", { hasText: "Enterprise Edition" }).locator("button.delete").click();
  await page.waitForFunction((count) => document.querySelectorAll("#terms-table tbody tr[data-id]").length === count - 1, before, { timeout: 5000 }).catch(() => {});
  expect((await englishColumn()).length === before - 1, "12: the row was not deleted");
  expect(!(await englishColumn()).includes("Enterprise Edition"), "12: the deleted row is still shown");
  await shot("11-editor");

  // Reload: the key is still in this tab; no new sign-in.
  await page.reload();
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 });
  expect((await text("#who-name")) === "amy", "12: the page forgot who was signed in after a reload");

  // ---------- 13. Setting a name and password ----------

  await page.click("#open-password");
  await passwordDialog.waitFor({ state: "visible", timeout: 3000 });
  // The two passwords differ: stopped by the page.
  await page.fill("#pw-new", "correct horse");
  await page.fill("#pw-repeat", "correct house");
  await page.click("#pw-save");
  expect((await text("#pw-status")) === "The two passwords are not the same.", `13: mismatched passwords: "${await text("#pw-status")}"`);
  // Password equals the name: stopped by the backend, reason shown in the dialog.
  await page.fill("#pw-login", "amy wong 1");
  await page.fill("#pw-new", "Amy Wong 1");
  await page.fill("#pw-repeat", "Amy Wong 1");
  await page.click("#pw-save");
  await waitForStatus("#pw-status", "same as the sign-in name");
  expect((await text("#pw-status")).includes("same as the sign-in name"), `13: a password equal to the name: "${await text("#pw-status")}"`);
  expect(await passwordDialog.isVisible(), "13: the dialog closed although nothing was saved");
  // Correct this time.
  await page.fill("#pw-login", "Amy Wong");
  await page.fill("#pw-new", "correct horse");
  await page.fill("#pw-repeat", "correct horse");
  await shot("12-create-password");
  await page.click("#pw-save");
  await passwordDialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  expect(await passwordDialog.isHidden(), `13: the password was not saved: "${await text("#pw-status")}"`);
  expect((await text("#terms-status")).includes('sign in as "Amy Wong"'), `13: wrong message after saving: "${await text("#terms-status")}"`);
  expect((await text("#open-password")) === "Change password", `13: the header button should now say Change password, says "${await text("#open-password")}"`);
  // From here the browser keeps the session token; the key is gone.
  let stored = await kept();
  expect(stored.key === null, "13: the API key is still kept in the browser after a password was set");
  expect((stored.computer ?? "").startsWith("lfs_") && stored.tab === null, `13: the sign-in token should be kept on this computer: ${JSON.stringify(Object.keys(stored).filter((name) => stored[name]))}`);
  const firstToken = stored.computer;
  // The page still works (with the token, not the key), and the role is still editor.
  await page.click('.tab[data-view="history"]');
  await page.locator("#history-table tbody tr").first().waitFor({ state: "visible", timeout: 5000 });
  expect((await text("#who-role")) === "editor", "13: the role changed after switching to the password sign-in");

  // Reload, and open in a new tab: no new sign-in either way.
  await page.reload();
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 });
  expect(await passwordDialog.isHidden(), "13: the password dialog appeared again after a reload");
  const second = await context.newPage();
  await second.goto(`${BASE}/admin/`);
  await second.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(((await second.locator("#who-name").textContent()) ?? "") === "amy", "13: a new tab should already be signed in");
  await second.close();

  // ---------- 14. Sign out, then sign in with name and password ----------

  await page.click("#sign-out");
  await page.locator("#view-login").waitFor({ state: "visible", timeout: 3000 });
  // Someone set a password on this computer, so the name-and-password form shows first.
  expect((await page.locator("#password-form").isVisible()) && (await page.locator("#login-form").isHidden()), "14: the sign-in page should now ask for name and password first");
  stored = await kept();
  expect(!stored.key && !stored.tab && !stored.computer, "14: something is still kept in the browser after signing out");
  await page.waitForTimeout(300);
  expect((await tokenStatus(firstToken)) === 401, "14: the sign-in token still works on the server after signing out");
  await shot("13-sign-in-with-password");

  await signInWithPassword("amy wong", "not the password");
  await waitForStatus("#login-status", "Wrong name or password");
  expect((await text("#login-status")) === "Wrong name or password", `14: a wrong password: "${await text("#login-status")}"`);
  expect(await page.locator("#view-terms").isHidden(), "14: a wrong password got in");

  // The name is case-insensitive. Without "Keep me signed in" this time: the token stays in this tab only.
  await signInWithPassword("amy wong", "correct horse", { keep: false });
  await page.locator("#terms-table tbody tr[data-id]").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect((await text("#who-name")) === "amy" && (await text("#who-role")) === "editor", `14: signed in as "${await text("#who-name")}" (${await text("#who-role")}), expected amy (editor)`);
  expect(await passwordDialog.isHidden(), "14: signing in with a password should not offer to create one");
  stored = await kept();
  expect((stored.tab ?? "").startsWith("lfs_") && stored.computer === null && stored.key === null, "14: without Keep me signed in, the token must stay in this tab only");
  // Signed in with a password, terms can be edited as usual, recorded under the same person.
  await page.click("#add-term");
  await page.fill("#term-en", "Zyphor Gateway");
  await page.click("#term-save");
  await waitForStatus("#terms-status", "Zyphor Gateway");
  await page.click('.tab[data-view="history"]');
  await page.locator("#history-table tbody tr").first().waitFor({ state: "visible", timeout: 5000 });
  expect((await text("#history-table tbody tr")).includes("amy") && (await text("#history-table tbody tr")).includes("Added Zyphor Gateway"), `14: the change was not logged under amy: "${await text("#history-table tbody tr")}"`);

  // ---------- 15. Changing the password needs the current one ----------

  await page.click("#open-password");
  await passwordDialog.waitFor({ state: "visible", timeout: 3000 });
  expect((await text("#pw-title")) === "Change password", `15: wrong dialog title: "${await text("#pw-title")}"`);
  expect(await page.locator("#pw-current-row").isVisible(), "15: changing the password must ask for the current one");
  expect((await page.inputValue("#pw-login")) === "Amy Wong", "15: the dialog should show the current sign-in name");
  await page.fill("#pw-current", "a wrong guess");
  await page.fill("#pw-new", "battery staple");
  await page.fill("#pw-repeat", "battery staple");
  await page.click("#pw-save");
  await waitForStatus("#pw-status", "current password is wrong");
  expect((await text("#pw-status")) === "The current password is wrong", `15: a wrong current password: "${await text("#pw-status")}"`);
  await page.fill("#pw-current", "correct horse");
  await shot("14-change-password");
  await page.click("#pw-save");
  await passwordDialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  expect(await passwordDialog.isHidden(), `15: the password was not changed: "${await text("#pw-status")}"`);
  // A new token, still in this tab only (as chosen at sign-in).
  const afterChange = await kept();
  expect((afterChange.tab ?? "").startsWith("lfs_") && afterChange.tab !== stored.tab && afterChange.computer === null, "15: the token was not replaced in the same place after the change");
  expect((await tokenStatus(stored.tab)) === 401, "15: the old token still works after the password was changed");

  await page.click("#sign-out");
  await signInWithPassword("Amy Wong", "correct horse");
  await waitForStatus("#login-status", "Wrong name or password");
  expect((await text("#login-status")) === "Wrong name or password", "15: the old password still works");
  await signInWithPassword("Amy Wong", "battery staple");
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(await page.locator("#view-terms").isVisible(), `15: the new password does not work: "${await text("#login-status")}"`);

  // ---------- 16. Forgot the password: sign in with the key and set a new one ----------

  await page.click("#sign-out");
  await signIn("sk-amy", { dismiss: false });
  expect(await passwordDialog.isVisible(), "16: signing in with the key again should offer to set a new password");
  expect((await text("#pw-title")) === "Change password", `16: wrong dialog title: "${await text("#pw-title")}"`);
  expect(await page.locator("#pw-current-row").isHidden(), "16: with the key, the forgotten password must not be asked for");
  await page.fill("#pw-new", "a third password");
  await page.fill("#pw-repeat", "a third password");
  await page.click("#pw-save");
  await passwordDialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await page.click("#sign-out");
  await signInWithPassword("Amy Wong", "a third password");
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  expect(await page.locator("#view-terms").isVisible(), `16: the password set after "forgot" does not work: "${await text("#login-status")}"`);
  await page.click("#sign-out");

  // ---------- 17. The admin sees on the People page who chose which sign-in name ----------

  await signIn("sk-root");
  await page.locator("#view-terms").waitFor({ state: "visible", timeout: 5000 });
  await page.click('.tab[data-view="people"]');
  await page.locator('#people-table tbody tr[data-alias="amy"]').waitFor({ state: "visible", timeout: 5000 });
  const amyCells = await page.locator('#people-table tbody tr[data-alias="amy"] td').allTextContents();
  expect(amyCells[1] === "Amy Wong", `17: People should show amy's sign-in name, shows ${JSON.stringify(amyCells.slice(0, 3))}`);
  await shot("15-people-with-sign-in-names");

  expect(problems.length === 0, `page errors: ${problems.join(" | ")}`);
} catch (error) {
  failures.push(`the test could not finish: ${String(error).split("\n")[0]}`);
} finally {
  await browser?.close();
  backend.kill();
  fake.close();
}

console.log(`screenshots: ${SHOTS}`);
if (failures.length === 0) {
  console.log("RESULT: PASS (now look at the screenshots)");
} else {
  for (const failure of failures) console.log(`FAILED: ${failure}`);
  if (/Traceback|ERROR/.test(backendLog)) console.log(`--- backend log ---\n${backendLog.slice(-3000)}`);
  console.log("RESULT: FAIL");
}
process.exit(failures.length === 0 ? 0 : 1);
