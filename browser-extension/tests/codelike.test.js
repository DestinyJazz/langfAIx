// Tests for deciding whether a field is a place for code.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isMonospaceFont, looksLikeCode } from "../lib/codelike.js";

test("monospace fonts are recognised", () => {
  for (const font of [
    "monospace",
    'Consolas, "Courier New", monospace',
    "Menlo, Monaco, monospace",
    '"SF Mono", ui-monospace',
    '"JetBrains Mono"',
    '"Fira Code"',
    '"Roboto Mono", sans-serif',
  ]) {
    assert.equal(isMonospaceFont(font), true, font);
  }
});

test("ordinary fonts are not monospace", () => {
  for (const font of ['"Google Sans"', "Arial, sans-serif", '"Segoe UI", system-ui', "Georgia, serif", "", undefined]) {
    assert.equal(isMonospaceFont(font), false, String(font));
  }
});

test("spellcheck off alone does not mean code", () => {
  // Both from real reports: TinyMCE's editing area and Google Translate's input turn spellcheck off but are for sentences.
  assert.equal(looksLikeCode({ spellcheckOff: true, fontFamily: "Helvetica, Arial, sans-serif" }), false);
  assert.equal(looksLikeCode({ spellcheckOff: true, fontFamily: '"Google Sans"' }), false);
});

test("monospace alone does not mean code", () => {
  // An unstyled textarea uses a monospace font by default. It is the most ordinary field and must be checked.
  assert.equal(looksLikeCode({ spellcheckOff: false, fontFamily: "monospace" }), false);
});

test("spellcheck off together with a monospace font means code", () => {
  assert.equal(looksLikeCode({ spellcheckOff: true, fontFamily: 'Consolas, "Courier New", monospace' }), true);
  assert.equal(looksLikeCode({ spellcheckOff: true, fontFamily: "monospace" }), true);
});

test("a known code editor is always treated as code", () => {
  assert.equal(looksLikeCode({ insideCodeEditor: true, spellcheckOff: false, fontFamily: "Arial" }), true);
});
