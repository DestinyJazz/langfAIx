// Decides whether a field is for writing code. Code is not checked, or every variable
// name and command would be a misspelling.
//
// The first version skipped any field with spellcheck="false", since code editors set
// that. It failed in practice: plenty of ordinary fields set it too, for example
//   - rich-text editors such as TinyMCE and CKEditor turn the browser's spellcheck off
//   - the input box of Google Translate
// and those fields "did nothing at all".
//
// Now a field counts as code only if spellcheck is off AND the font is monospace. Code
// and terminals almost always use a monospace font; prose almost never does. Known code
// editors are also recognised by their markers.

// A font family containing one of these is monospace.
const MONOSPACE = /mono|monaco|courier|consolas|menlo|lucida console|source code|fira code|jetbrains|cascadia|inconsolata/i;

// fontFamily is the computed font list, e.g. 'Consolas, "Courier New", monospace'.
export function isMonospaceFont(fontFamily) {
  return MONOSPACE.test(String(fontFamily ?? ""));
}

// field is a plain object:
//   spellcheckOff     whether the page turned spellcheck off for the field
//   fontFamily        the field's font
//   insideCodeEditor  whether it sits inside a known code editor (the caller checks the DOM)
export function looksLikeCode(field) {
  if (field.insideCodeEditor) return true;
  return Boolean(field.spellcheckOff) && isMonospaceFont(field.fontFamily);
}
