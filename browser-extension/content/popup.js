// The suggestion card: a small panel next to the field. Two kinds of content:
//
//   rule card  appears while the pointer rests on a red squiggle. Shows what is wrong and
//              the suggestions; one click replaces. At the bottom, an entry to have the
//              AI rewrite the sentence.
//   AI card    appears after the user used an AI entry. Shows the sentence with deleted
//              text struck through in red and added text in blue, the reasons, the tokens
//              and cost of this call, and Accept and Dismiss.
//
// The card is drawn in a Shadow DOM, isolated from the page's styles, on the outermost
// page (see frames.js), so it is not clipped when the field sits in a low iframe.

import { rootContext } from "./frames.js";

// Most suggestions shown at once. LanguageTool already orders them by likelihood.
const MAX_SUGGESTIONS = 4;
// Gap in pixels between card and squiggle, and between card and window edge.
const GAP = 8;

// Issue type names, shown at the top of the card.
const KIND_LABELS = {
  misspelling: "Spelling",
  grammar: "Grammar",
  typographical: "Punctuation",
  style: "Style",
  duplication: "Repeated word",
  whitespace: "Spacing",
  // Found by the team glossary: a registered wrong form, or an untranslated Chinese term in English text.
  terminology: "Terminology",
};

// The explanation on a hint card, by reason.
const HINT_MESSAGES = {
  issues: "This sentence has several issues. AI can rewrite it in one go.",
  style: "The wording of this sentence could be clearer.",
  long: "This sentence is long. AI may be able to tighten it.",
};

const CSS_TEXT = `
  :host {
    all: initial;
  }
  .card {
    position: fixed;
    box-sizing: border-box;
    width: max-content;
    min-width: 200px;
    max-width: 380px;
    max-height: 70vh;
    overflow-y: auto;
    padding: 12px 14px 10px;
    border: 1px solid #d0d7de;
    border-radius: 10px;
    background: #ffffff;
    box-shadow: 0 8px 24px rgba(31, 35, 40, 0.18);
    color: #1f2328;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: left;
  }
  .kind {
    margin-bottom: 8px;
    color: #656d76;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .kind.ai {
    color: #6639ba;
  }
  .fix {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .old {
    color: #cf222e;
    text-decoration: line-through;
    overflow-wrap: anywhere;
  }
  .arrow {
    color: #656d76;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  .suggestion {
    padding: 3px 10px;
    border: 1px solid #1a7f37;
    border-radius: 6px;
    background: #ffffff;
    color: #1a7f37;
    font-weight: 600;
    overflow-wrap: anywhere;
    text-align: left;
  }
  .suggestion:first-of-type {
    background: #1a7f37;
    color: #ffffff;
  }
  .suggestion:hover,
  .accept:hover {
    filter: brightness(0.92);
  }
  .message {
    margin-bottom: 8px;
    color: #424a53;
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 -14px;
    padding: 8px 14px 0;
    border-top: 1px solid #eaeef2;
  }
  .link {
    padding: 2px 0;
    border: 0;
    background: none;
    color: #656d76;
    font-size: 13px;
  }
  .link:hover {
    color: #1f2328;
    text-decoration: underline;
  }
  .link.ai {
    margin-left: auto;
    color: #6639ba;
    font-weight: 600;
  }

  /* ---------- AI card ---------- */
  .section + .section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed #d0d7de;
  }
  .diff {
    margin-bottom: 6px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  /* Text to delete: red, struck through */
  .removed {
    color: #cf222e;
    text-decoration: line-through;
  }
  /* Text to add: blue */
  .added {
    color: #0969da;
    font-weight: 600;
  }
  /* A little space between deleted text and the added text right after it, or the two words run together */
  .removed + .added {
    margin-left: 4px;
  }
  .reasons {
    margin: 0 0 6px;
    padding-left: 18px;
    color: #424a53;
    font-size: 13px;
  }
  .cost {
    margin-bottom: 8px;
    color: #656d76;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin-bottom: 8px;
    color: #656d76;
    font-size: 12px;
  }
  /* Several sentences: the list scrolls, the total and the buttons below do not */
  .list {
    max-height: calc(70vh - 170px);
    min-height: 90px;
    margin: 0 -14px;
    padding: 0 14px;
    overflow-y: auto;
  }
  /* The checkbox before each sentence, and the total at the bottom */
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }
  .pick {
    flex: 0 0 auto;
    margin: 4px 0 0;
  }
  .row .diff {
    flex: 1 1 auto;
    min-width: 0;
  }
  .cost.total {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #eaeef2;
    color: #424a53;
    font-weight: 600;
  }
  /* Which model answered. Small, so it does not compete with the cost line */
  .model {
    margin-bottom: 8px;
    color: #656d76;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .problem {
    margin-bottom: 8px;
    color: #cf222e;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .waiting {
    margin-bottom: 8px;
    color: #424a53;
  }
  .accept {
    padding: 4px 14px;
    border: 1px solid #1a7f37;
    border-radius: 6px;
    background: #1a7f37;
    color: #ffffff;
    font-weight: 600;
  }
  /* The "Improve with AI" button on a hint card: the AI purple, distinct from the green Accept */
  .accept.improve {
    border-color: #6639ba;
    background: #6639ba;
  }
  .estimate {
    color: #656d76;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  /* Push the button to the right end of the row */
  .right {
    margin-left: auto;
  }
`;

export class SuggestionPopup {
  constructor() {
    this.host = null; // created when first shown; nothing is added to the page before
    this.card = null;
    this.root = null; // the page the card is mounted on, and the coordinate offset
    this.anchor = null; // the text the card is placed next to
    this.match = null; // the issue on a rule card; null otherwise
    this.hint = null; // the hint on a hint card; null otherwise
    this.pinned = false; // an AI card is pinned: it stays when the pointer leaves, until the user closes it
    this.open = false;
    this.onPointer = () => {}; // tells the main flow when the pointer enters or leaves the card
  }

  get visible() {
    return this.open;
  }

  // ---------- Rule card ----------

  // match       the issue to show
  // anchor      position of the underlined text, in viewport coordinates of the field's page
  // onApply     called with the replacement when the user picks a suggestion
  // onDismiss   called when the user clicks Dismiss
  // onImprove   called when the user asks the AI to rewrite the sentence. Absent: no such entry
  // onAddWord   called when the user adds the word to the personal dictionary. Absent: no
  //             such button (only spelling issues provide it)
  show({ match, anchor, onApply, onDismiss, onImprove, onAddWord }) {
    this.begin(anchor);
    this.match = match;
    this.hint = null;
    this.pinned = false;
    const el = this.el;

    const kind = el("div", "kind", KIND_LABELS[match.issue_type] ?? "Suggestion");

    const fix = el("div", "fix");
    fix.append(el("span", "old", match.text));
    const suggestions = match.replacements.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length > 0) fix.append(el("span", "arrow", "→"));
    for (const replacement of suggestions) {
      // An empty suggestion means "remove this".
      fix.append(this.button("suggestion", replacement === "" ? "(remove)" : replacement, () => onApply(replacement)));
    }

    const message = el("div", "message", match.message);

    const actions = el("div", "actions");
    actions.append(this.button("link dismiss", "Dismiss", onDismiss));
    // Dismiss lasts until the page reloads; the dictionary is permanent and applies on every site.
    if (onAddWord) actions.append(this.button("link add-word", "Add to dictionary", onAddWord));
    if (onImprove) actions.append(this.button("link ai", "Improve sentence with AI", onImprove));

    this.card.replaceChildren(kind, fix, message, actions);
    this.place();
  }

  // ---------- Hint card ----------

  // Appears while the pointer rests on a lavender hint line. Only an invitation: up to here
  // no AI was called and nothing was spent.
  // hint        the hint, with its reason
  // estimate    the "about this much" text; empty without data
  // onImprove   called when the user asks the AI to rewrite
  // onDismiss   called when the user clicks Dismiss
  showHint({ hint, anchor, estimate, onImprove, onDismiss }) {
    this.begin(anchor);
    this.match = null;
    this.hint = hint;
    this.pinned = false;
    const el = this.el;

    const kind = el("div", "kind ai", "Improve your text");
    const message = el("div", "message", HINT_MESSAGES[hint.reason] ?? HINT_MESSAGES.issues);
    const note = el("div", "note", "Nothing has been sent yet. Only this sentence is sent when you click.");

    const actions = el("div", "actions");
    actions.append(this.button("accept improve", "Improve with AI", onImprove));
    if (estimate) actions.append(el("span", "estimate", estimate));
    actions.append(this.button("link dismiss right", "Dismiss", onDismiss));

    this.card.replaceChildren(kind, message, note, actions);
    this.place();
  }

  // ---------- AI card ----------

  // state is one of:
  //   { kind: "loading", note }                                 note says what is being sent
  //   { kind: "error", message, onOpenOptions, onDismiss }      no onOpenOptions: no such button
  //   { kind: "result", sections, total, note, onAccept, onDismiss }
  //      onAccept   absent: no Accept. Called with the indexes of the ticked sections, or
  //                 null (meaning all) when the card has no checkboxes
  //      total      the total line for several sentences; empty for one
  //      modelLine  which model answered, e.g. Model: langfAIx-model-1. Absent: not shown
  //      sections   one per sentence: { segments, reasons, costLine, problem, hasEdits }
  //        segments  the pieces to show, see lib/diff.js
  //        reasons   the reasons for the edits
  //        costLine  the tokens-and-cost line
  //        problem   why this sentence failed, or empty
  //        hasEdits  whether the AI suggested edits for it
  showAi({ anchor, state }) {
    this.begin(anchor);
    this.match = null;
    this.hint = null;
    this.pinned = true;
    this.renderAi(state);
  }

  // Change the content of an open card, e.g. from "waiting" to the result.
  updateAi(state) {
    if (!this.open || !this.pinned) return;
    this.renderAi(state);
  }

  renderAi(state) {
    const el = this.el;
    const parts = [el("div", "kind ai", "Improve your text")];
    const actions = el("div", "actions");

    if (state.kind === "loading") {
      parts.push(el("div", "waiting", "Asking AI..."));
      parts.push(el("div", "note", state.note || "Only this sentence is sent."));
    } else if (state.kind === "error") {
      parts.push(el("div", "problem", state.message));
      if (state.onOpenOptions) actions.append(this.button("accept", "Open options", state.onOpenOptions));
      actions.append(this.button("link dismiss", "Close", state.onDismiss));
    } else {
      // Several sentences sent and more than one has edits: each of those gets a checkbox, so
      // the user can accept only some. All ticked by default.
      const choosable = state.sections.filter((section) => section.hasEdits).length > 1;
      const picks = []; // each { index, input }
      const boxes = []; // one box per sentence

      for (const [index, section] of state.sections.entries()) {
        const box = el("div", "section");
        const diff = el("div", "diff");
        for (const segment of section.segments) {
          diff.append(segment.type === "same" ? this.root.document.createTextNode(segment.text) : el("span", segment.type, segment.text));
        }
        if (choosable && section.hasEdits) {
          const input = el("input", "pick");
          input.type = "checkbox";
          input.checked = true;
          picks.push({ index, input });
          // Wrapped in a label, so clicking the sentence text toggles the checkbox.
          const row = el("label", "row");
          row.append(input, diff);
          box.append(row);
        } else {
          box.append(diff);
        }
        if (section.reasons.length > 0) {
          const list = el("ul", "reasons");
          for (const reason of section.reasons) list.append(el("li", "", reason));
          box.append(list);
        }
        if (section.problem) box.append(el("div", "problem", section.problem));
        if (section.costLine) box.append(el("div", "cost", section.costLine));
        boxes.push(box);
      }
      if (boxes.length > 1) {
        // With several sentences the list scrolls by itself, so the total and the Accept button
        // stay visible however long it is.
        const list = el("div", "list");
        list.append(...boxes);
        parts.push(list);
      } else {
        parts.push(...boxes);
      }
      if (state.total) parts.push(el("div", "cost total", state.total));
      if (state.modelLine) parts.push(el("div", "model", state.modelLine));
      if (state.note) parts.push(el("div", "note", state.note));
      if (state.onAccept) {
        // With checkboxes: the indexes of the ticked sections. Without: null, meaning all.
        const accept = () => state.onAccept(choosable ? picks.filter((pick) => pick.input.checked).map((pick) => pick.index) : null);
        actions.append(this.button("accept", choosable ? "Accept selected" : "Accept", accept));
      }
      actions.append(this.button("link dismiss", state.onAccept ? "Dismiss" : "Close", state.onDismiss));
    }

    if (actions.childNodes.length > 0) parts.push(actions);
    this.card.replaceChildren(...parts);
    this.place();
  }

  // ---------- Shared by all cards ----------

  hide() {
    if (!this.host) return;
    this.open = false;
    this.match = null;
    this.hint = null;
    this.pinned = false;
    this.host.remove();
  }

  // Whether a node belongs to the card. The main flow uses it to detect clicks outside.
  owns(node) {
    return Boolean(this.host) && node === this.host;
  }

  // Before showing: decide which page to mount on and remember the anchor.
  begin(anchor) {
    this.root = rootContext();
    this.anchor = anchor;
    this.mount(this.root.document);
    this.open = true;
    // Elements must be created by the document the card lives in (the outer page when the field is in an iframe).
    this.el = (tag, className, text) => {
      const element = this.root.document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text; // textContent: never interpreted as HTML
      return element;
    };
  }

  button(className, text, onClick) {
    const button = this.el("button", className, text);
    button.type = "button";
    button.addEventListener("click", () => onClick());
    return button;
  }

  mount(doc) {
    if (!this.host || this.host.ownerDocument !== doc) {
      this.host?.remove();
      this.host = doc.createElement("langfaix-popup");
      this.host.style.cssText =
        "all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important;" +
        " width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;";
      const shadow = this.host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = CSS_TEXT;
      this.card = doc.createElement("div");
      this.card.className = "card";
      this.card.setAttribute("role", "dialog");
      this.card.setAttribute("aria-label", "Writing suggestion");
      shadow.append(style, this.card);

      // A mousedown on the card must not blur the field, or the caret leaves and there is
      // nowhere to put the replacement.
      this.card.addEventListener("mousedown", (event) => event.preventDefault());
      this.card.addEventListener("mouseenter", () => this.onPointer(true));
      this.card.addEventListener("mouseleave", () => this.onPointer(false));
    }
    if (!this.host.isConnected) doc.documentElement.append(this.host);
  }

  // Place the card: below the text by default, above when there is no room below, never outside the window sideways.
  place() {
    const { root, anchor } = this;
    const view = root.document.defaultView;
    // From the field's page coordinates to the outermost page's.
    const left = anchor.left + root.offsetX;
    const top = anchor.top + root.offsetY;
    const bottom = anchor.bottom + root.offsetY;

    const size = this.card.getBoundingClientRect();
    let x = Math.min(left, view.innerWidth - size.width - GAP);
    x = Math.max(x, GAP);
    let y = bottom + GAP;
    if (y + size.height > view.innerHeight - GAP && top - GAP - size.height >= GAP) {
      y = top - GAP - size.height; // no room below, room above
    }
    // No room above or below (a tall card): at least stay inside the bottom of the window.
    y = Math.max(GAP, Math.min(y, view.innerHeight - size.height - GAP));
    this.card.style.left = `${Math.round(x)}px`;
    this.card.style.top = `${Math.round(y)}px`;
  }
}
