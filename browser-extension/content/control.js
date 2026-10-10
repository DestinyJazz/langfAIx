// Adapter for plain fields (textarea and input).
//
// textarea, input and rich-text areas differ a lot, and the main flow (main.js) should not
// care. Each kind is wrapped in the same few methods:
//   isAlive()       is the field still in the page
//   readText()      the text in it now
//   shouldCheck()   is this text worth sending for a check
//   render(...)     draw the results
//   selection()     where the caret is, or what is selected
//   everyFrame()    per-frame work (following the field's position)
//   destroy()       finish and restore the page
// The main flow only uses these.

import { looksLikeProse } from "../lib/sensitive.js";
import { silenceNativeSpellcheck } from "./spellcheck.js";

export class ControlAdapter {
  // overlay is the mirror that draws squiggles: one per page, passed in by the main flow.
  constructor(field, overlay) {
    this.field = field;
    this.single = field instanceof HTMLInputElement;
    this.overlay = overlay;
    this.overlay.attach(field);
    this.restoreSpellcheck = silenceNativeSpellcheck(field);
  }

  isAlive() {
    if (!this.field.isConnected || this.field.disabled) return false;
    // A page may turn the input into a password field while we watch ("hide password"). Let go at once.
    if (this.single && this.field.type !== "text") return false;
    return true;
  }

  readText() {
    return this.field.value;
  }

  // A single word in a single-line input is not checked: a name, a number or a keyword, not a sentence.
  shouldCheck(text) {
    return this.single ? looksLikeProse(text) : text.trim() !== "";
  }

  render(text, matches, hints) {
    this.overlay.render(text, matches, hints);
  }

  everyFrame() {
    this.overlay.sync();
  }

  // Screen position of each underline, used to tell which one the pointer is on.
  markRects() {
    return this.overlay.markRects();
  }

  // Caret position or selected range: { start, end }, equal for a caret.
  selection() {
    const start = this.field.selectionStart ?? 0;
    return { start, end: this.field.selectionEnd ?? start };
  }

  // Replace one issue with the suggested text. True on success.
  apply(match, replacement) {
    return this.replace(match.offset, match.length, match.text, replacement);
  }

  // Replace the text at offset (length long) with replacement. True on success. expected is
  // what should be there now. Rule suggestions and AI edits both go through here.
  replace(offset, length, expected, replacement) {
    const field = this.field;
    const start = offset;
    const end = offset + length;
    // Verify first: is the text at that position still what was checked? If not, the text
    // changed and the position is unreliable: do nothing.
    if (field.value.slice(start, end) !== expected) return false;

    field.focus();
    field.setSelectionRange(start, end);

    // Preferred: let the browser make the change as if the user typed it. Ctrl+Z then undoes
    // it, and the page's own code gets the normal input events. execCommand is old but still
    // supported everywhere, and nothing else keeps undo working.
    const before = field.value;
    field.ownerDocument.execCommand(replacement === "" ? "delete" : "insertText", false, replacement);
    if (field.value !== before) return true;

    // Fallback: change the text directly and notify the page by hand.
    field.setRangeText(replacement, start, end, "end");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: replacement }));
    return field.value !== before;
  }

  destroy() {
    this.overlay.detach();
    this.restoreSpellcheck();
  }
}
