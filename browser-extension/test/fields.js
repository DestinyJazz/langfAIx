// Script of the test page.
//
// This page belongs to the extension, and Chrome injects no content scripts into the
// extension's own pages, so the code used in web pages is imported and started here
// directly. It is exactly the same code, and every kind of field can be tried without
// finding a real site.

import { start } from "../content/main.js";

// Expose what start() returns on window, so automated tests can ask which words are
// underlined and where. Only this test page does so; in real pages the extension's code
// is isolated from the page.
window.__langfaix = start();
