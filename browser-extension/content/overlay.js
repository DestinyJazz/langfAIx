// Draws squiggles over a field. Used for textarea (multi-line) and input (single-line).
//
// The difficulty: text inside these fields cannot be styled, so a few characters cannot
// simply be underlined. The usual answer is a mirror: an invisible div exactly on top of
// the field, holding the same text with the same font, line height, padding and wrapping,
// so every character sits where it does in the field. The mirror's text is transparent;
// only the squiggles show, and they look as if drawn in the field.
//
// The mirror lives in a Shadow DOM, isolated from the page: page styles do not reach it
// and its styles do not leak out.

import { splitIntoLayers } from "../lib/segments.js";

// Styles that affect text layout. All are copied from the field; miss one and characters may not line up.
const COPIED_STYLES = [
  "direction",
  "fontFamily",
  "fontFeatureSettings",
  "fontKerning",
  "fontSize",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontVariationSettings",
  "fontWeight",
  "hyphens",
  "letterSpacing",
  "lineHeight",
  "overflowWrap",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "tabSize",
  "textAlign",
  "textIndent",
  "textRendering",
  "textTransform",
  "whiteSpace",
  "wordBreak",
  "wordSpacing",
  "writingMode",
];

const SHADOW_CSS = `
  /* Clip box: as large as the visible inside of the field; anything beyond is hidden */
  .clip {
    position: absolute;
    overflow: hidden;
    pointer-events: none;
  }
  /* Mirror: transparent text; clicks pass through to the field below */
  .mirror {
    position: absolute;
    left: 0;
    top: 0;
    box-sizing: border-box;
    margin: 0;
    border: 0;
    background: none;
    color: transparent;
    -webkit-text-fill-color: transparent;
    pointer-events: none;
    user-select: none;
  }
  /* Single-line input: no wrapping, text centred vertically */
  .mirror.single {
    display: flex;
    align-items: center;
  }
  .mirror.single .line {
    flex: 0 0 auto;
    min-width: 100%;
    white-space: pre;
  }
  /* An issue: red squiggle. The text stays transparent; only the line shows */
  .err {
    text-decoration: underline wavy #cf222e;
    text-decoration-skip-ink: none;
    text-underline-offset: 0.15em;
  }
  /* The "could read better" hint: thin lavender dashes, quieter than red. Free; no AI is called */
  .hint {
    text-decoration: underline dotted #8250df;
    text-decoration-thickness: 1.5px;
    text-decoration-skip-ink: none;
    text-underline-offset: 0.2em;
  }
  /* Single-line inputs are short, with hardly any room below the text: draw the line thin and close, or the field's edge clips it */
  .mirror.single .err,
  .mirror.single .hint {
    text-decoration-thickness: 1px;
    text-underline-offset: 0;
  }
`;

export class Overlay {
  constructor() {
    // The host element, attached at the top of the page. all: initial clears whatever the page applies to it.
    this.host = document.createElement("langfaix-overlay");
    // Stacking, bottom to top: squiggles (here), the corner badge and its menu, suggestion
    // cards. Hence 2 below the maximum, or squiggles would cover menus and cards.
    this.host.style.cssText =
      "all: initial !important; position: absolute !important; left: 0 !important; top: 0 !important;" +
      " width: 0 !important; height: 0 !important; z-index: 2147483645 !important;" +
      " pointer-events: none !important; display: block !important;";

    const root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    this.clip = document.createElement("div");
    this.clip.className = "clip";
    this.mirror = document.createElement("div");
    this.mirror.className = "mirror";
    // All text goes in line. Multi-line: a plain container. Single-line: it provides no-wrap and horizontal scrolling.
    this.line = document.createElement("div");
    this.line.className = "line";
    this.mirror.append(this.line);
    this.clip.append(this.mirror);
    root.append(style, this.clip);

    this.field = null;
    this.marks = []; // the underlines drawn now
    this.single = false; // single-line input?
    this.extraBottom = 0; // extra height below the clip box
    this.lastGeometry = "";
    // The field was resized (e.g. the user dragged its corner): copy the layout again.
    this.resizeObserver = new ResizeObserver(() => this.copyStyles());
  }

  attach(field) {
    this.detach();
    this.field = field;
    this.single = field instanceof HTMLInputElement;
    this.mirror.classList.toggle("single", this.single);
    document.documentElement.append(this.host);
    this.resizeObserver.observe(field);
    this.copyStyles();
    this.sync();
  }

  // Stop, and remove the mirror from the page.
  detach() {
    if (!this.field) return;
    this.resizeObserver.disconnect();
    this.host.remove();
    this.line.replaceChildren();
    this.marks = [];
    this.mirror.style.transform = "";
    this.line.style.transform = "";
    this.field = null;
    this.lastGeometry = "";
  }

  copyStyles() {
    if (!this.field) return;
    const computed = getComputedStyle(this.field);
    for (const name of COPIED_STYLES) this.mirror.style[name] = computed[name];
    // Let squiggles extend a little below, onto the bottom border. Some fields are short or
    // exactly as tall as their last line (Google Translate's input): half of the last line's
    // squiggle would fall outside the visible area and be clipped.
    this.extraBottom = (parseFloat(computed.borderBottomWidth) || 0) + 2;
    this.lastGeometry = ""; // force the next sync to reposition
  }

  // Draw text, rule issues and "could read better" hints into the mirror: red squiggles for
  // issues, lavender dashes for the rest of a hinted sentence.
  render(text, matches, hints) {
    const nodes = [];
    this.marks = []; // which issue or hint each underline belongs to, for hit testing
    for (const layer of splitIntoLayers(text, matches, hints)) {
      if (!layer.match && !layer.hint) {
        nodes.push(document.createTextNode(layer.text));
        continue;
      }
      const span = document.createElement("span");
      span.className = layer.match ? "err" : "hint";
      span.textContent = layer.text;
      nodes.push(span);
      this.marks.push(layer.match ? { span, match: layer.match } : { span, hint: layer.hint });
    }
    this.line.replaceChildren(...nodes);
  }

  // Screen rectangles of each underline. A word wrapped over two lines has two. Only the
  // parts inside the field's visible area are returned.
  markRects() {
    if (!this.field) return [];
    const view = this.field.getBoundingClientRect();
    const result = [];
    for (const { span, match, hint } of this.marks) {
      for (const rect of span.getClientRects()) {
        if (rect.bottom < view.top || rect.top > view.bottom || rect.right < view.left || rect.left > view.right) continue;
        result.push({ match, hint, rect });
      }
    }
    return result;
  }

  // Keep the mirror on the field: position, size, scroll offset. Called every frame. Mostly
  // nothing changed, and it returns after reading a few numbers.
  sync() {
    const field = this.field;
    if (!field) return;

    const rect = field.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    // Relative to the host element, so page scrolling and the host's placement do not matter.
    const left = rect.left - hostRect.left + field.clientLeft;
    const top = rect.top - hostRect.top + field.clientTop;
    const width = field.clientWidth;
    const height = field.clientHeight;
    const scrollLeft = field.scrollLeft;
    const scrollTop = field.scrollTop;

    const geometry = `${left},${top},${width},${height},${scrollLeft},${scrollTop}`;
    if (geometry === this.lastGeometry) return;
    this.lastGeometry = geometry;

    // The clip box covers the visible inside of the field (no border, no scrollbar).
    this.clip.style.left = `${left}px`;
    this.clip.style.top = `${top}px`;
    this.clip.style.width = `${width}px`;
    this.clip.style.height = `${height + this.extraBottom}px`;
    this.clip.style.display = width === 0 || height === 0 ? "none" : "block";

    // Same width as the field's content box, so lines wrap at the same places.
    this.mirror.style.width = `${width}px`;

    if (this.single) {
      // Single-line: same height as the field, text centred vertically by style; scrolls sideways only.
      this.mirror.style.height = `${height}px`;
      this.line.style.transform = `translateX(${-scrollLeft}px)`;
    } else {
      // Multi-line: height follows the content; the whole mirror moves with the scroll position.
      this.mirror.style.height = "";
      this.mirror.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    }
  }
}
