// The badge in the corner of a field, and the menu it opens.
//
// The badge sits at the bottom right of the field in use and is always visible:
//   number on red   the rule check found this many issues
//   tick on green   no issues
// Clicking it opens a card with, top to bottom:
//   lookup      Chinese or English in, the standard term from the team glossary out; click to copy
//   AI rewrite  this sentence, the selection, the whole text
//   switch      use the team glossary or not
// Neither badge nor card calls the AI. Text is only sent when the user picks a rewrite.
//
// Like the suggestion card it is drawn in a Shadow DOM on the outermost page (frames.js).
// This file only handles where it is drawn and what it looks like. Which items the menu
// has and what they do is decided by the main flow (main.js).

import { rootContext } from "./frames.js";

// Fields lower than this are "short" (single-line, in practice) and get a different placement.
const SHORT_FIELD_HEIGHT = 44;
// No badge when less than this much of the field is visible.
const MIN_VISIBLE_WIDTH = 60;
const MIN_VISIBLE_HEIGHT = 14;
// Badge diameter: normal, and for short fields.
const SIZE = 22;
const SMALL_SIZE = 16;
// Distance from the inner edge of the field.
const MARGIN = 6;
// A textarea has a resize handle at the bottom right; the badge moves left of it.
const RESIZE_HANDLE = 12;
// Gap between menu and badge, and between menu and window edge.
const GAP = 6;

const CSS_TEXT = `
  :host {
    all: initial;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .dot {
    position: fixed;
    box-sizing: border-box;
    width: ${SIZE}px;
    height: ${SIZE}px;
    padding: 0;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(31, 35, 40, 0.35);
    color: #ffffff;
    font: 700 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center;
    opacity: 0.88;
  }
  .dot:hover,
  .dot.open {
    opacity: 1;
  }
  /* Issues: red. Deliberately not the squiggle red: automated tests count squiggle-red pixels to tell whether lines were drawn */
  .dot.issues {
    background: #e5534b;
  }
  /* No issues: green */
  .dot.clean {
    background: #2da44e;
  }
  .dot.small {
    width: ${SMALL_SIZE}px;
    height: ${SMALL_SIZE}px;
    border-width: 1px;
    font-size: 9px;
  }
  .menu {
    position: fixed;
    box-sizing: border-box;
    width: max-content;
    min-width: 240px;
    max-width: 340px;
    padding: 6px 0;
    border: 1px solid #d0d7de;
    border-radius: 10px;
    background: #ffffff;
    box-shadow: 0 8px 24px rgba(31, 35, 40, 0.18);
    color: #1f2328;
    font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: left;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 14px 8px;
    border-bottom: 1px solid #eaeef2;
    color: #656d76;
    font-size: 12px;
  }
  .brand {
    color: #6639ba;
    font-weight: 700;
  }
  .item {
    display: block;
    width: 100%;
    padding: 7px 14px;
    border: 0;
    background: none;
    color: #1f2328;
    text-align: left;
  }
  .item:hover:not(:disabled) {
    background: #f3f0fa;
  }
  .item:disabled {
    color: #8c959f;
    cursor: default;
  }
  .label {
    display: block;
    font-weight: 600;
  }
  .detail {
    display: block;
    color: #656d76;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .item:disabled .detail {
    color: #9a6700;
  }
  /* ---------- Lookup ---------- */
  .lookup {
    padding: 8px 14px 6px;
    border-bottom: 1px solid #eaeef2;
  }
  .term {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 8px;
    border: 1px solid #8c959f;
    border-radius: 6px;
    background: #ffffff;
    color: #1f2328;
    font: inherit;
  }
  .term:focus {
    outline: 2px solid #6639ba;
    outline-offset: -1px;
  }
  .lookup-status {
    margin-top: 4px;
    color: #656d76;
    font-size: 12px;
  }
  .lookup-status:empty {
    display: none;
  }
  .lookup-status.error {
    color: #cf222e;
  }
  .results {
    max-height: 170px;
    margin-top: 4px;
    overflow-y: auto;
  }
  .result {
    padding: 4px 0;
    border-top: 1px solid #eaeef2;
  }
  .result:first-child {
    border-top: 0;
  }
  /* Chinese and English are a button each; click to copy */
  .copy {
    margin: 0 6px 0 -4px;
    padding: 1px 4px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: #1f2328;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .copy:hover {
    border-color: #d0d7de;
    background: #f6f8fa;
  }
  .copy.en {
    font-weight: 600;
  }
  .copy.copied {
    border-color: #1a7f37;
    color: #1a7f37;
  }
  .applies {
    display: block;
    color: #656d76;
    font-size: 12px;
  }
  /* ---------- Glossary switch ---------- */
  .switch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-top: 1px solid #eaeef2;
    font-size: 13px;
    cursor: pointer;
  }
  .switch input {
    margin: 0;
  }
  .foot {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 14px 4px;
    border-top: 1px solid #eaeef2;
    color: #656d76;
    font-size: 12px;
  }
  .options {
    padding: 0;
    border: 0;
    background: none;
    color: #656d76;
    font-size: 12px;
    text-decoration: underline;
    white-space: nowrap;
  }
`;

// Intersection of two rectangles. Width or height is negative when they do not overlap.
function intersect(a, b) {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

// The inside of an element: without border and scrollbar.
function innerBox(element) {
  const rect = element.getBoundingClientRect();
  const left = rect.left + element.clientLeft;
  const top = rect.top + element.clientTop;
  return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
}

export class Badge {
  constructor() {
    this.host = null; // created when first shown
    this.dot = null;
    this.menu = null;
    this.field = null;
    this.clippers = []; // ancestors that clip part of the field (scrollable panels and the like)
    this.resizable = false;
    this.wanted = false; // what the main flow wants
    this.count = 0;
    this.shown = false; // whether it is really on the page now
    this.menuOpen = false;
    this.pointerInside = false; // pointer over badge or menu
    this.rect = null; // badge position in the field's page coordinates; the AI card is placed next to it
    this.lastGeometry = "";
    this.hasFocus = false; // caret in the card's lookup box
    this.onOpen = () => {}; // the user clicked the badge
    this.onBlur = () => {}; // the caret left the card
  }

  attach(field) {
    this.detach();
    this.field = field;
    const style = getComputedStyle(field);
    this.resizable = field instanceof HTMLTextAreaElement && style.resize !== "none";
    // Collect, once, the ancestors that clip or scroll their content. When the field scrolls
    // out of their visible area, the badge must not float outside.
    this.clippers = [];
    for (let parent = field.parentElement; parent; parent = parent.parentElement) {
      if (parent === field.ownerDocument.documentElement || parent === field.ownerDocument.body) continue;
      const overflow = getComputedStyle(parent);
      // Inline elements (measured as 0 by 0) do not clip their content.
      const hasBox = parent.clientWidth > 0 || parent.clientHeight > 0;
      if (hasBox && /auto|scroll|hidden|clip/.test(overflow.overflowX + overflow.overflowY)) this.clippers.push(parent);
    }
  }

  // Stop, and remove the badge from the page.
  detach() {
    this.closeMenu();
    this.host?.remove();
    this.field = null;
    this.clippers = [];
    this.wanted = false;
    this.shown = false;
    this.pointerInside = false;
    this.rect = null;
    this.lastGeometry = "";
  }

  // The main flow says whether to show the badge and how many issues there are.
  setState({ visible, count }) {
    this.wanted = visible;
    if (count !== this.count) {
      this.count = count;
      this.lastGeometry = ""; // the count changed: redraw next frame
    }
    if (!visible) this.hide();
  }

  hide() {
    if (!this.shown) return;
    this.closeMenu();
    this.host.remove();
    this.shown = false;
    this.pointerInside = false;
    this.rect = null;
    this.lastGeometry = "";
  }

  // Whether a node belongs to the badge or its menu.
  owns(node) {
    return Boolean(this.host) && node === this.host;
  }

  // Keep the badge on the field. Called every frame; mostly nothing changed and it returns after reading a few numbers.
  sync() {
    const field = this.field;
    if (!field || !this.wanted) return;

    const doc = field.ownerDocument.documentElement;
    const viewport = { left: 0, top: 0, right: doc.clientWidth, bottom: doc.clientHeight };
    // In editors such as TinyMCE the whole frame body is the editing area. The body is only
    // as tall as its text, but what the user sees as the field is the frame, so the frame's
    // viewport is used.
    const isPage = field === field.ownerDocument.body;
    const box = isPage ? viewport : field.getBoundingClientRect();
    const inner = isPage ? viewport : innerBox(field);

    // What can be seen: this page's viewport minus the clipping ancestors.
    let clip = viewport;
    for (const clipper of this.clippers) clip = intersect(clip, innerBox(clipper));
    // The part of the field that is really visible.
    const visible = intersect(inner, clip);

    const root = rootContext();
    const rootView = root.document.defaultView;
    const geometry = [box.left, box.top, box.right, box.bottom, visible.left, visible.top, visible.right, visible.bottom, root.offsetX, root.offsetY, rootView.innerWidth, rootView.innerHeight].join(",");
    if (geometry === this.lastGeometry) return;
    this.lastGeometry = geometry;

    const small = box.bottom - box.top < SHORT_FIELD_HEIGHT;
    const size = small ? SMALL_SIZE : SIZE;
    let left;
    let top;
    let fits = visible.right - visible.left >= MIN_VISIBLE_WIDTH && visible.bottom - visible.top >= MIN_VISIBLE_HEIGHT;

    if (small) {
      // Short (single-line) field: no room inside without covering text, so the badge straddles
      // the bottom-right corner, half outside. If that corner is clipped away, no badge.
      if (box.right > clip.right + 1 || box.bottom > clip.bottom + 1) fits = false;
      // A short textarea has a resize handle too: move left and sit on the bottom border.
      left = box.right - size / 2 - (this.resizable ? RESIZE_HANDLE + size / 2 : 0);
      top = box.bottom - size / 2;
    } else {
      // Tall field: inside, at the bottom right. When its lower part is scrolled off screen,
      // the badge stays at the bottom right of the visible part. If even the badge does not fit
      // there, no badge, rather than one sticking out of the field.
      if (visible.bottom - visible.top < size + MARGIN) fits = false;
      const atOwnCorner = Math.abs(visible.right - inner.right) < 1 && Math.abs(visible.bottom - inner.bottom) < 1;
      left = visible.right - MARGIN - size - (this.resizable && atOwnCorner ? RESIZE_HANDLE : 0);
      top = visible.bottom - MARGIN - size;
    }

    // Convert to coordinates of the outermost page (they differ when the field is in an iframe).
    let x = left + root.offsetX;
    let y = top + root.offsetY;
    // The badge centre is outside the window (the whole iframe scrolled away): no badge.
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    if (centerX < 0 || centerY < 0 || centerX > rootView.innerWidth || centerY > rootView.innerHeight) fits = false;

    if (!fits) {
      this.hide();
      this.lastGeometry = geometry; // hide clears it; restore it so it is not recomputed every frame
      return;
    }

    // A straddling badge may stick out of the window: pull it in a little.
    x = Math.max(2, Math.min(x, rootView.innerWidth - size - 2));
    y = Math.max(2, Math.min(y, rootView.innerHeight - size - 2));
    this.rect = { left: x - root.offsetX, top: y - root.offsetY, right: x - root.offsetX + size, bottom: y - root.offsetY + size };
    this.show(root.document, x, y, small);
  }

  show(doc, x, y, small) {
    this.mount(doc);
    this.dot.style.left = `${Math.round(x)}px`;
    this.dot.style.top = `${Math.round(y)}px`;

    const issues = this.count > 0;
    const most = small ? 9 : 99; // the small badge has no room for two digits
    this.dot.textContent = issues ? (this.count > most ? `${most}+` : String(this.count)) : "✓";
    this.dot.className = `dot ${issues ? "issues" : "clean"}${small ? " small" : ""}${this.menuOpen ? " open" : ""}`;
    const summary = issues ? `${this.count} ${this.count === 1 ? "issue" : "issues"} found` : "no issues found";
    this.dot.title = `langfAIx: ${summary}. Click for AI options.`;
    this.dot.setAttribute("aria-label", this.dot.title);
    this.shown = true;
    if (this.menuOpen) this.placeMenu();
  }

  // ---------- Menu ----------

  // model is the card content, supplied by the main flow:
  //   summary    one line at the top right, e.g. "3 issues found"
  //   lookup     { search(query) } returning { rows } or { error }. Absent: no lookup box
  //   items      AI rewrite choices, each { label, detail, disabled, onPick }
  //   glossary   the glossary switch: { on, onToggle(on) }. Absent: no switch
  //   note       the note at the bottom
  //   onOptions  called when Options is clicked
  openMenu(model) {
    if (!this.shown) return;
    const doc = this.host.ownerDocument;
    const el = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };

    const head = el("div", "head");
    head.append(el("span", "brand", "langfAIx"), el("span", "summary", model.summary));

    const parts = [head];
    if (model.lookup) parts.push(this.buildLookup(el, model.lookup));
    for (const item of model.items) {
      const button = el("button", "item");
      button.type = "button";
      button.disabled = Boolean(item.disabled);
      button.append(el("span", "label", item.label));
      if (item.detail) button.append(el("span", "detail", item.detail));
      button.addEventListener("click", () => {
        // If the caret is in the lookup box, give it back to the field first. Otherwise, with the
        // card closed, the caret is nowhere and the main flow thinks the user left.
        const back = this.hasFocus;
        this.closeMenu();
        if (back) this.field?.focus({ preventScroll: true });
        item.onPick();
      });
      parts.push(button);
    }

    if (model.glossary) {
      const row = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = model.glossary.on;
      box.addEventListener("change", () => model.glossary.onToggle(box.checked));
      row.append(box, el("span", "", "Use the team glossary"));
      parts.push(row);
    }

    const foot = el("div", "foot");
    foot.append(el("span", "note", model.note));
    const options = el("button", "options", "Options");
    options.type = "button";
    options.addEventListener("click", () => {
      this.closeMenu();
      model.onOptions();
    });
    foot.append(options);
    parts.push(foot);

    this.menu.replaceChildren(...parts);
    this.menu.hidden = false;
    this.menuOpen = true;
    this.dot.classList.add("open");
    this.placeMenu();
  }

  closeMenu() {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.hasFocus = false;
    this.menu.hidden = true;
    this.menu.replaceChildren();
    this.dot.classList.remove("open");
  }

  // The glossary switch was changed elsewhere: update the tick if the card is open.
  setGlossary(on) {
    const box = this.menuOpen ? this.menu.querySelector(".switch input") : null;
    if (box) box.checked = on;
  }

  // The lookup box at the top of the card, and its results.
  buildLookup(el, lookup) {
    const box = el("div", "lookup");
    const input = el("input", "term");
    input.type = "text";
    input.placeholder = "Look up a term: Chinese or English";
    input.autocomplete = "off";
    input.spellcheck = false;
    const status = el("div", "lookup-status");
    const list = el("div", "results");
    box.append(input, status, list);

    const say = (text, kind = "") => {
      status.textContent = text;
      status.className = `lookup-status ${kind}`.trim();
    };
    let timer = 0;
    let number = 0; // number of searches sent, to drop stale replies

    const run = async () => {
      const query = input.value.trim();
      const mine = ++number;
      if (!query) {
        list.replaceChildren();
        say("");
        this.placeMenu();
        return;
      }
      const answer = await lookup.search(query);
      if (mine !== number || !this.menuOpen) return; // the user typed on, or the card is closed
      list.replaceChildren();
      if (answer.error) {
        say(answer.error, "error");
      } else {
        for (const row of answer.rows) {
          const item = el("div", "result");
          item.append(this.copyButton(el, row.en, "en", input, say));
          if (row.zh) item.append(this.copyButton(el, row.zh, "zh", input, say));
          // One Chinese term with several English terms: the applies-to text tells them apart.
          if (row.applies_to) item.append(el("span", "applies", `Applies to: ${row.applies_to}`));
          list.append(item);
        }
        say(answer.rows.length === 0 ? "No term like this in the glossary." : "Click a term to copy it.");
      }
      this.placeMenu(); // the card height changed: place it again
    };
    const soon = (delay) => {
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    };

    input.addEventListener("input", (event) => {
      // While an IME is composing (pinyin not yet turned into characters) do not search; wait for compositionend.
      if (!event.isComposing) soon(250);
    });
    input.addEventListener("compositionend", () => soon(100));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") soon(0);
      if (event.key === "Escape") {
        this.closeMenu();
        this.field?.focus({ preventScroll: true }); // caret back to the field, to keep writing
      }
    });
    return box;
  }

  // A click-to-copy button.
  copyButton(el, text, className, input, say) {
    const button = el("button", `copy ${className}`, text);
    button.type = "button";
    button.title = "Click to copy";
    button.addEventListener("click", async () => {
      const ok = await this.copy(text, input);
      say(ok ? `Copied: ${text}` : "Could not copy. Select the text and copy it yourself.", ok ? "" : "error");
      if (!ok) return;
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 900);
    });
    return button;
  }

  // Put text on the clipboard. True on success.
  async copy(text, input) {
    const doc = this.host.ownerDocument;
    const view = doc.defaultView;
    try {
      // The modern way: https pages only, and the page must have focus.
      if (view.isSecureContext && view.navigator.clipboard) {
        await view.navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Otherwise fall back to the old way below.
    }
    // The old way: put the text in an invisible textarea, select it, run the copy command.
    // The only option on plain-http intranet systems.
    const area = doc.createElement("textarea");
    area.value = text;
    area.style.cssText = "position: fixed; left: -9999px; top: 0; opacity: 0;";
    this.menu.append(area);
    area.select();
    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    input.focus({ preventScroll: true }); // the invisible textarea took the caret: give it back
    return ok;
  }

  // The menu goes right below the badge, right-aligned; above it when there is no room below.
  placeMenu() {
    const view = this.host.ownerDocument.defaultView;
    const dot = this.dot.getBoundingClientRect();
    const size = this.menu.getBoundingClientRect();
    let x = dot.right - size.width;
    x = Math.max(GAP, Math.min(x, view.innerWidth - size.width - GAP));
    let y = dot.bottom + GAP;
    if (y + size.height > view.innerHeight - GAP && dot.top - GAP - size.height >= GAP) {
      y = dot.top - GAP - size.height;
    }
    y = Math.max(GAP, Math.min(y, view.innerHeight - size.height - GAP));
    this.menu.style.left = `${Math.round(x)}px`;
    this.menu.style.top = `${Math.round(y)}px`;
  }

  mount(doc) {
    if (!this.host || this.host.ownerDocument !== doc) {
      this.host?.remove();
      this.host = doc.createElement("langfaix-badge");
      this.host.style.cssText =
        "all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important;" +
        " width: 0 !important; height: 0 !important; z-index: 2147483646 !important; display: block !important;";
      const view = doc.defaultView;
      // An open Shadow DOM, so automated tests can click the buttons inside (as for the suggestion card).
      const shadow = this.host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = CSS_TEXT;
      this.dot = doc.createElement("button");
      this.dot.type = "button";
      this.dot.className = "dot";
      this.menu = doc.createElement("div");
      this.menu.className = "menu";
      this.menu.setAttribute("role", "menu");
      this.menu.hidden = true;
      shadow.append(style, this.dot, this.menu);

      // A mousedown on badge or menu must not blur the field. Otherwise one click moves the
      // caret out, and "the sentence at the caret" and "the selection" are gone.
      for (const element of [this.dot, this.menu]) {
        element.addEventListener("mousedown", (event) => {
          // Exception: the lookup box must be clickable for typing.
          if (event.target instanceof view.HTMLInputElement && event.target.type === "text") return;
          event.preventDefault();
        });
        element.addEventListener("mouseenter", () => (this.pointerInside = true));
        element.addEventListener("mouseleave", () => (this.pointerInside = false));
      }
      this.dot.addEventListener("click", () => this.onOpen());

      // While the caret is in the lookup box the field has no focus. Record it, so the main
      // flow does not conclude the user left and close the card.
      this.menu.addEventListener("focusin", () => (this.hasFocus = true));
      this.menu.addEventListener("focusout", () => {
        this.hasFocus = false;
        this.onBlur();
      });
      // Keys typed in the lookup box must not reach the page: many sites have single-key shortcuts (c for compose).
      for (const type of ["keydown", "keyup", "keypress"]) {
        this.menu.addEventListener(type, (event) => event.stopPropagation());
      }
    }
    if (!this.host.isConnected) doc.documentElement.append(this.host);
  }
}
