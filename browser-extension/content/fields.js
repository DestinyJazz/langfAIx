// Decides whether what the user clicked into is a field we handle, and gives it an adapter.
//
// Three kinds:
//   textarea          multi-line field
//   input             single-line field. The strictest rules; see lib/sensitive.js
//   contenteditable   rich-text editing area, e.g. the compose box of a webmail

import { looksLikeCode } from "../lib/codelike.js";
import { inputSkipReason } from "../lib/sensitive.js";
import { ControlAdapter } from "./control.js";
import { EditableAdapter } from "./editable.js";

// Too small to be for sentences.
const MIN_WIDTH = 80;
const MIN_HEIGHT = 16;
// A single-line input must be wider: narrow ones hold codes, quantities, numbers.
const MIN_INPUT_WIDTH = 150;

// Known code editors and code elements. Fields inside them are not checked.
const CODE_EDITORS = ".CodeMirror, .cm-editor, .monaco-editor, .ace_editor, pre, code";

// Two reasons not to check: the page opts out of grammar tools, or this is a place for code.
function optedOut(element) {
  const data = element.dataset;
  if (data.langfaix === "false" || data.gramm === "false" || data.enableGrammarly === "false") return true;
  // spellcheck="false" alone is not enough; many ordinary fields set it. See lib/codelike.js.
  return looksLikeCode({
    spellcheckOff: element.spellcheck === false,
    fontFamily: getComputedStyle(element).fontFamily,
    insideCodeEditor: Boolean(element.closest(CODE_EDITORS)),
  });
}

// Editable areas nest. The caret may be in an inner part; walk up to the outermost
// editable element and use that.
function editingHost(element) {
  let host = element;
  while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
  return host;
}

// The label text next to the input, e.g. "Customer name:". The input's own name is often
// an abbreviation (custname); the label is written for people and tells more.
function labelText(input) {
  const parts = [];
  for (const label of input.labels ?? []) parts.push(label.textContent);
  for (const id of (input.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
    const element = id && document.getElementById(id);
    if (element) parts.push(element.textContent);
  }
  return parts.join(" ").slice(0, 200);
}

// Returns the element to watch, or null if it is not ours to handle.
export function findField(target) {
  if (!(target instanceof HTMLElement)) return null;

  if (target instanceof HTMLTextAreaElement) {
    if (target.disabled || target.readOnly || optedOut(target)) return null;
    if (target.clientWidth < MIN_WIDTH || target.clientHeight < MIN_HEIGHT) return null;
    return target;
  }

  if (target instanceof HTMLInputElement) {
    if (target.disabled || target.readOnly || optedOut(target)) return null;
    if (target.clientWidth < MIN_INPUT_WIDTH || target.clientHeight < MIN_HEIGHT) return null;
    const reason = inputSkipReason({
      type: target.getAttribute("type"), // the raw attribute as the page wrote it, not the browser's normalised value
      autocomplete: target.getAttribute("autocomplete"),
      name: target.name,
      id: target.id,
      placeholder: target.placeholder,
      ariaLabel: target.getAttribute("aria-label"),
      label: labelText(target),
      role: target.getAttribute("role"),
      inputMode: target.getAttribute("inputmode"),
      list: target.getAttribute("list"),
    });
    return reason ? null : target;
  }

  if (target.isContentEditable && EditableAdapter.supported()) {
    const host = editingHost(target);
    if (optedOut(host)) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return null;
    return host;
  }

  return null;
}

export function createAdapter(field, overlay) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    return new ControlAdapter(field, overlay);
  }
  return new EditableAdapter(field);
}
