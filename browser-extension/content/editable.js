// Adapter for rich-text areas (contenteditable): the compose box of a webmail, comment
// boxes, ticket editors.
//
// Such an area holds real elements: a <div> or <p> per paragraph, <b> for bold, <br> for
// a line break. A mirror cannot reproduce that, so the browser's CSS Custom Highlight API
// is used instead:
//   1. a Range marks "from character n of this text node to character m of that one"
//   2. the Ranges are registered as a highlight named langfaix-error
//   3. the stylesheet says ::highlight(langfaix-error) { red squiggle } and the browser draws it
// The content of the area is never modified, so the page's own code is not disturbed.
//
// One problem remains: the server knows plain text and positions, the area is a tree. So
// the tree is flattened to plain text while recording which node each piece came from;
// when the server says "characters 40 to 48", the node and offset can be found again.

import { splitIntoLayers } from "../lib/segments.js";
import { silenceNativeSpellcheck } from "./spellcheck.js";

// Names of the two highlight groups. Their styles are in content/page.css.
const ERROR_HIGHLIGHT = "langfaix-error"; // rule issues: red squiggle
const HINT_HIGHLIGHT = "langfaix-hint"; // "could read better" hints: lavender dashes

// Block-level elements. Flattening adds a line break around them, or the last word of
// one paragraph would run into the first word of the next.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV",
  "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

// Not body text: skipped entirely.
const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

// Elements that sit inside a sentence but must not be checked: inline code, images,
// embedded objects, and non-editable chips (an @mention). Their content is skipped but a
// placeholder stays. Without it "Thanks [chip] for" becomes "Thanks  for": the server
// reports a double space and the squiggle lands on the chip.
const OPAQUE_TAGS = new Set(["CODE", "IMG", "SVG", "CANVAS", "IFRAME", "OBJECT", "VIDEO", "AUDIO", "BUTTON", "SELECT", "INPUT", "TEXTAREA"]);

// U+FFFC, the Unicode character reserved for "an embedded object is here"; it does not occur in normal text.
const PLACEHOLDER = String.fromCharCode(0xfffc);

// Flatten the area to plain text. Returns { text, pieces }; each piece records a text
// node and where its content starts in text.
export function flatten(root) {
  let text = "";
  const pieces = [];
  let breakPending = false; // a block boundary was passed: break the line before the next text

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue;
      if (!value) return;
      if (breakPending && text !== "" && !text.endsWith("\n")) text += "\n";
      breakPending = false;
      pieces.push({ node, start: text.length, length: value.length });
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toUpperCase();
    if (tag === "BR") {
      text += "\n";
      breakPending = false;
      return;
    }
    if (IGNORED_TAGS.has(tag)) return;
    // Quoted content is not checked: the old mail in a reply was written by someone else and
    // is often long. BLOCKQUOTE is the general marker; gmail_quote is Gmail's.
    if (tag === "BLOCKQUOTE" || node.classList.contains("gmail_quote")) {
      breakPending = true;
      return;
    }
    if (OPAQUE_TAGS.has(tag) || node.getAttribute("contenteditable") === "false") {
      if (breakPending && text !== "" && !text.endsWith("\n")) text += "\n";
      breakPending = false;
      text += PLACEHOLDER; // a placeholder maps to no text node, so it is not recorded in pieces
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) breakPending = true;
    for (const child of node.childNodes) visit(child);
    if (isBlock) breakPending = true;
  }

  for (const child of root.childNodes) visit(child);
  return { text, pieces };
}

// Find the text node and offset for position `offset` in text. atEnd: looking for the end
// of a range; exactly on a boundary it belongs to the end of the earlier node.
function locate(pieces, offset, atEnd) {
  // Binary search: pieces are sorted by start.
  let low = 0;
  let high = pieces.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const piece = pieces[middle];
    const end = piece.start + piece.length;
    if (offset > end || (offset === end && !atEnd)) low = middle + 1;
    else high = middle;
  }
  const piece = pieces[low];
  if (!piece) return null;
  // On a line break we inserted ourselves the position belongs to no node: snap to the nearest node edge.
  const inside = Math.min(Math.max(offset - piece.start, 0), piece.length);
  return { node: piece.node, offset: inside };
}

// Convert (offset, length) to a Range in the page.
function toRange(pieces, offset, length) {
  const start = locate(pieces, offset, false);
  const end = locate(pieces, offset + length, true);
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null; // the page just changed the node: skip this one for now
  }
  return range.collapsed ? null : range;
}

// The reverse: a position in the page (node, offset) as an index into the flattened text.
// Answers "which sentence is the caret in" and "what did the user select".
// atEnd: the position ends a selection. Between two pieces, an end belongs to the end of
// the earlier piece and a start to the beginning of the later one.
function toOffset(flat, node, offset, atEnd) {
  const { pieces, text } = flat;
  if (node.nodeType === Node.TEXT_NODE) {
    const piece = pieces.find((item) => item.node === node);
    if (piece) return piece.start + Math.min(offset, piece.length);
  }
  // The position is on an element (the caret in an empty paragraph) or in text we do not
  // check (inline code): use the nearest piece before or after.
  const point = node.ownerDocument.createRange();
  point.setStart(node, offset);
  point.collapse(true);
  let before = null;
  for (const piece of pieces) {
    // comparePoint above 0: this piece starts after the position.
    if (point.comparePoint(piece.node, 0) > 0) {
      return atEnd && before ? before.start + before.length : piece.start;
    }
    before = piece;
  }
  return before ? before.start + before.length : text.length;
}

export class EditableAdapter {
  // A browser too old for custom highlights cannot support this kind of area.
  static supported() {
    return typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS;
  }

  constructor(host) {
    this.field = host;
    this.restoreSpellcheck = silenceNativeSpellcheck(host);
    this.flat = flatten(host);
    this.dirty = false;
    this.repaint = false; // nodes were replaced: redraw from the latest result
    this.lastMatches = []; // the issues drawn last
    this.lastHints = []; // the hints drawn last
    this.marks = []; // the underlines drawn now
    // Any change of text or structure marks the area as needing a new flatten. Not done here:
    // one keystroke can fire several mutations, and once per frame is enough.
    this.observer = new MutationObserver(() => {
      this.dirty = true;
    });
    this.observer.observe(host, { characterData: true, childList: true, subtree: true });
  }

  isAlive() {
    return this.field.isConnected;
  }

  readText() {
    if (this.dirty) {
      this.flat = flatten(this.field);
      this.dirty = false;
      // Some pages replace the area's elements wholesale without changing a single character.
      // Old Ranges then point at removed nodes and the lines vanish, so repaint in that case too.
      this.repaint = true;
    }
    return this.flat.text;
  }

  shouldCheck(text) {
    return text.trim() !== "";
  }

  // Draw rule issues and "could read better" hints: issues as one highlight group (red
  // squiggles), hints as another (lavender dashes).
  render(text, matches, hints) {
    this.lastMatches = matches;
    this.lastHints = hints;
    this.repaint = false;
    this.marks = []; // issue or hint and Range of each underline, for hit testing and replacing

    // Draw only if the flatten result on hand really is this text; otherwise positions are off.
    if (text === this.flat.text) {
      // The same segmenting function as for plain fields, so both draw alike: the lavender line
      // breaks where a red one is.
      let offset = 0;
      for (const layer of splitIntoLayers(text, matches, hints)) {
        const start = offset;
        offset += layer.text.length;
        if (!layer.match && !layer.hint) continue;
        // A range containing a placeholder is not drawn: the line would sit on the embedded object.
        if (layer.text.includes(PLACEHOLDER)) continue;
        const range = toRange(this.flat.pieces, start, layer.text.length);
        if (!range) continue;
        this.marks.push(layer.match ? { range, match: layer.match } : { range, hint: layer.hint });
      }
    }

    this.register(ERROR_HIGHLIGHT, this.marks.filter((mark) => mark.match));
    this.register(HINT_HIGHLIGHT, this.marks.filter((mark) => mark.hint));
  }

  // Register Ranges as a highlight group; with none, remove the group.
  register(name, marks) {
    if (marks.length === 0) CSS.highlights.delete(name);
    else CSS.highlights.set(name, new Highlight(...marks.map((mark) => mark.range)));
  }

  // Screen position of each underline. A word over two lines, or half bold, has several rectangles.
  markRects() {
    const result = [];
    for (const { range, match, hint } of this.marks) {
      for (const rect of range.getClientRects()) result.push({ match, hint, rect });
    }
    return result;
  }

  // Caret position or selected range: { start, end } as indexes into the flattened text.
  // Null when the caret is not in this area.
  selection() {
    const selection = this.field.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.field.contains(range.commonAncestorContainer)) return null;
    this.readText(); // make sure the flatten result is current
    try {
      const start = toOffset(this.flat, range.startContainer, range.startOffset, false);
      const end = range.collapsed ? start : toOffset(this.flat, range.endContainer, range.endOffset, true);
      return { start, end: Math.max(start, end) };
    } catch {
      return null; // the page just changed the node
    }
  }

  // Replace one issue with the suggested text. True on success.
  apply(match, replacement) {
    return this.replace(match.offset, match.length, match.text, replacement);
  }

  // Replace the text at offset (length long) with replacement. True on success. expected is
  // what should be there now. Rule suggestions and AI edits both go through here.
  replace(offset, length, expected, replacement) {
    // Flatten again every time. AI edits are applied one after another, and after each one
    // the editor may have split or merged nodes, so the recorded pieces are stale.
    this.flat = flatten(this.field);
    this.dirty = false;
    this.repaint = true;
    const range = toRange(this.flat.pieces, offset, length);
    // Verify first: does the Range still hold the text that was checked?
    if (!range || range.toString() !== expected) return false;
    const mark = { range };

    const doc = this.field.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) return false;
    // Clicking a card may have moved focus out of the area (especially when it is in an iframe): take it back.
    this.field.focus({ preventScroll: true });
    // Select the text, then let the browser replace the selection as if the user typed. The
    // editor's own code (TinyMCE and others) gets normal input events, and Ctrl+Z undoes it.
    selection.removeAllRanges();
    selection.addRange(mark.range.cloneRange());
    return doc.execCommand(replacement === "" ? "delete" : "insertText", false, replacement);
  }

  everyFrame() {
    // The browser draws highlights and moves them with the text; nothing to adjust per frame.
    // Only when nodes were replaced without a text change is the latest result drawn again.
    // (On a text change the main flow has already called render, which cleared repaint.)
    if (this.repaint) this.render(this.flat.text, this.lastMatches, this.lastHints);
  }

  destroy() {
    this.observer.disconnect();
    CSS.highlights.delete(ERROR_HIGHLIGHT);
    CSS.highlights.delete(HINT_HIGHLIGHT);
    this.restoreSpellcheck();
  }
}
