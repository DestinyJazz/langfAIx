// Checks what is handed to users: the zip and install guide made by deploy/pack-extension.ps1.
//
// The usual tests load the browser-extension folder, which also holds development-only
// files. Users get the zip. A file missing from the zip goes unnoticed by the usual tests
// and only shows once someone installs it. So the zip is unpacked to a temporary folder,
// really loaded into a browser, and all checks of extension.mjs are run on it.
//
// What it checks:
//   1. the zip has no development files and manifest.json is at the top level
//   2. every file in the zip equals the current code (catches a forgotten re-pack)
//   3. the install guide has the right version and server address and no unfilled marker;
//      a screenshot is taken
//   4. the unpacked extension is loaded into a browser and extension.mjs is run
//
// Usage (in the e2e folder, after running deploy/pack-extension.ps1):
//   npm run packed -- https://your-server/api
//
// Rule checks only; no AI, no cost.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

const API = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!API) {
  console.error("Usage: npm run packed -- https://your-server.example.com/api");
  process.exit(2);
}

const SOURCE = fileURLToPath(new URL("../browser-extension/", import.meta.url));
const BUILD = fileURLToPath(new URL("../deploy/build/", import.meta.url));
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
// The same tar.exe the pack script uses.
const TAR = join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const finish = () => {
  for (const failure of failures) console.log(`FAILED: ${failure}`);
  console.log(failures.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(failures.length === 0 ? 0 : 1);
};

const version = JSON.parse(readFileSync(join(SOURCE, "manifest.json"), "utf8")).version;
const zip = join(BUILD, `langfaix-extension-${version}.zip`);
const guide = join(BUILD, "langfaix-extension-install-guide.html");
if (!existsSync(zip)) {
  // Also reached when the version changed without a re-pack.
  failures.push(`there is no ${zip}. Run deploy/pack-extension.ps1 first.`);
  finish();
}

// ---------- 1. What is in the zip ----------

const entries = execFileSync(TAR, ["-tf", zip], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const files = entries.filter((entry) => !entry.endsWith("/"));
expect(entries.includes("manifest.json"), "manifest.json is not at the top of the zip, so the unzipped folder cannot be loaded directly");
const stray = entries.filter((entry) => /^tests\/|(^|\/)package(-lock)?\.json$|\.py$|node_modules/.test(entry));
expect(stray.length === 0, `development-only files are in the zip: ${stray.join(", ")}`);
// A zip with backslash separators unpacks on Windows but breaks elsewhere and in the store.
expect(!entries.some((entry) => entry.includes("\\")), "the zip uses backslashes in file names");

// ---------- 2. Same as the current code? ----------

const unpacked = mkdtempSync(join(tmpdir(), "langfaix-packed-"));
execFileSync(TAR, ["-xf", zip, "-C", unpacked]);
const outdated = files.filter((name) => !existsSync(join(SOURCE, name)) || !readFileSync(join(unpacked, name)).equals(readFileSync(join(SOURCE, name))));
expect(outdated.length === 0, `the zip is not the same as the code now (run deploy/pack-extension.ps1 again): ${outdated.slice(0, 5).join(", ")}`);

// ---------- 3. The install guide ----------

if (!existsSync(guide)) {
  failures.push(`there is no ${guide}`);
} else {
  const html = readFileSync(guide, "utf8");
  expect(!html.includes("{{"), "the install guide still has a {{...}} mark that was not filled in");
  expect(html.includes(`langfaix-extension-${version}.zip`), `the install guide does not name the zip for version ${version}`);
  // The address in the guide must be exactly the one this test can reach. One mistyped character at pack time and every user enters it wrong.
  expect(html.includes(`<code>${API}</code>`), `the install guide does not give ${API} as the server address`);
  expect(html.includes(`<code>${API}/admin/</code>`), "the install guide does not give the glossary page address");
  expect(html.includes(`<code>${new URL(API).host}</code>`), "the install guide does not tell colleagues to add the server's domain to the specific-sites list");
  expect(!html.includes("<!--"),"the developer notes were not removed from the install guide");

  // Screenshots for layout: how it looks on screen, and how many pages it prints on.
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await page.goto(pathToFileURL(guide).href);
  await page.screenshot({ path: join(SHOTS, "packed-guide.png"), fullPage: true });
  const pdf = await page.pdf({ path: join(SHOTS, "packed-guide.pdf"), format: "A4", margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" } });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  // Designed for two pages: installing on the first, everyday reference on the second. More means content should be trimmed.
  expect(pages <= 2, `the install guide prints on ${pages} pages, it should fit on 2`);
  // Another shot with print styles (about the width of A4 minus margins), to see printed size and spacing.
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width: 688, height: 980 });
  await page.screenshot({ path: join(SHOTS, "packed-guide-print.png"), fullPage: true });
  console.log(`install guide : ${guide} (prints on ${pages} A4 page${pages === 1 ? "" : "s"}), see shots/packed-guide.png, packed-guide-print.png and packed-guide.pdf`);
  await browser.close();
}

console.log(`zip           : ${zip} (${files.length} files)`);
console.log(`unpacked to   : ${unpacked}`);

// ---------- 4. Load the unpacked extension into a browser ----------

if (failures.length === 0) {
  console.log("\n--- running extension.mjs against the unpacked zip ---");
  const run = spawnSync(process.execPath, ["extension.mjs", API], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, LANGFAIX_EXTENSION_DIR: unpacked },
  });
  expect(run.status === 0, "the extension from the zip did not pass extension.mjs (see above)");
  console.log("--- end of extension.mjs ---\n");
}

finish();
