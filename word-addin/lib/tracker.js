// Bookkeeping: which paragraphs were checked, what was found, which squiggle belongs to
// which issue.
//
// The add-in's main flow (taskpane.js) looks at the paragraphs on screen about once a
// second and asks here which of them should be checked now. After checking and drawing it
// reports the results back. The task pane's issue list also comes from here.
//
// Why keep our own record instead of asking Word: when the user picks a suggestion in
// Word's popup, Word removes the line first and notifies the add-in afterwards. By then
// the line is gone and Word can no longer say what it was (found in real Word).
//
// Two kinds of entry are recorded:
//   rule issue  a red line. One entry is one line in the document; the entry id is the
//               line's id
//   hint        "this sentence could read better", lavender. Colours cannot be stacked,
//               so a sentence's hint line breaks at red lines into several pieces: one
//               entry has several lines (or none, if the user turned drawing off). The
//               entry id is our own
// Every entry has lineIds: the ids of its lines in the document.
//
// Bookkeeping only; no Word calls, so this is testable without Word.

// Pause in typing before the paragraph being edited is re-checked (ms). Same as the browser extension.
export const DEBOUNCE_MS = 700;
// How many recently removed lines are remembered.
const GONE_LIMIT = 200;
// The "rule name" of a hint. A hint is not reported by a backend rule; it is computed locally.
export const HINT_RULE = "HINT";

// What an issue is: the same rule on the same word is the same issue. After a dismissal
// this keeps it from being drawn again on a re-check.
export function issueKey(match) {
  return `${match.rule_id ?? ""}|${match.text ?? ""}`;
}

// A hint in the shape of a rule issue, so bookkeeping and dismissal share one path.
export function hintMatch(sentence, reason) {
  return { rule_id: HINT_RULE, issue_type: "hint", text: sentence, reason, replacements: [] };
}

export class Tracker {
  constructor({ debounceMs = DEBOUNCE_MS } = {}) {
    this.debounceMs = debounceMs;
    // paragraph id -> { text, since }: the text seen last, and since when it has not changed
    this.seen = new Map();
    // paragraph id -> the text version that was checked. Same text: no new check.
    this.checked = new Map();
    // entry id -> entry { id, paragraphId, start, length, match, lineIds }
    this.issues = new Map();
    // paragraph id -> the ids of its entries
    this.byParagraph = new Map();
    // line id in the document -> the entry it belongs to
    this.owner = new Map();
    // issues the user dismissed (until the task pane closes)
    this.dismissed = new Set();
    // Which entry a just-removed line belonged to. On Ignore, Word first reports "line
    // removed" and then "user clicked Ignore"; the second needs this to know which issue was
    // meant. Only recent ones are kept.
    this.gone = new Map();
  }

  // A look at the paragraphs on screen. Returns those due for a check now ([{ id, text }]).
  //   paragraphs  the paragraphs on screen, each { id, text }
  //   now         the current time in ms; a parameter so tests can set the clock
  observe(paragraphs, now) {
    const due = [];
    for (const { id, text } of paragraphs) {
      const before = this.seen.get(id);
      const firstTime = before === undefined;
      // Text differs from last time: the user is editing it; restart the timer.
      const since = firstTime || before.text !== text ? now : before.since;
      this.seen.set(id, { text, since });

      if (this.checked.get(id) === text) continue;
      if (!text.trim()) {
        // Nothing to check in an empty paragraph: record it as checked.
        this.record(id, text, []);
        continue;
      }
      // A paragraph seen for the first time (scrolled into view) is checked at once. A known one
      // whose text changed (the user is typing) waits for a pause, so not every keystroke checks.
      if (firstTime || now - since >= this.debounceMs) due.push({ id, text });
    }
    return due;
  }

  isDismissed(match) {
    return this.dismissed.has(issueKey(match));
  }

  // No more "could read better" hints for this sentence (the AI looked at it, or the user declined).
  quiet(sentence) {
    this.dismissed.add(issueKey(hintMatch(sentence)));
  }

  isQuiet(sentence) {
    return this.dismissed.has(issueKey(hintMatch(sentence)));
  }

  // Record the check result of a paragraph.
  //   text     the text version that was checked
  //   entries  the paragraph's entries, each { id, start, length, match, lineIds }. Without
  //            lineIds the entry id is taken as the line id (true for rule issues)
  // Earlier results for this paragraph are discarded.
  record(paragraphId, text, entries) {
    for (const id of this.byParagraph.get(paragraphId) ?? []) this.forget(id);
    this.checked.set(paragraphId, text);
    this.byParagraph.set(paragraphId, entries.map((entry) => entry.id));
    for (const entry of entries) {
      const lineIds = entry.lineIds ?? [entry.id];
      this.issues.set(entry.id, { ...entry, lineIds, paragraphId });
      for (const lineId of lineIds) this.owner.set(lineId, entry.id);
    }
  }

  // Remove an entry from the record (without a "just removed" note).
  forget(entryId) {
    const entry = this.issues.get(entryId);
    if (!entry) return null;
    this.issues.delete(entryId);
    for (const lineId of entry.lineIds) this.owner.delete(lineId);
    const rest = (this.byParagraph.get(entry.paragraphId) ?? []).filter((id) => id !== entryId);
    this.byParagraph.set(entry.paragraphId, rest);
    return entry;
  }

  // The lines recorded on this paragraph (they are deleted from the document before a redraw).
  linesOf(paragraphId) {
    return (this.byParagraph.get(paragraphId) ?? []).flatMap((id) => this.issues.get(id)?.lineIds ?? []);
  }

  // The entry a document line belongs to, or null if we did not draw it.
  entryOfLine(lineId) {
    return this.issues.get(this.owner.get(lineId)) ?? null;
  }

  // A line disappeared from the document (a suggestion was accepted, or Word removed it
  // because the text changed).
  // Rule issue: the entry goes with it. Returns that entry.
  // Hint: only one stretch of line is gone; the hint stays (a text change leads to a
  // re-check that recomputes it). Returns null.
  lineGone(lineId) {
    const entry = this.entryOfLine(lineId);
    if (!entry) return null;
    if (entry.match.rule_id === HINT_RULE) {
      entry.lineIds = entry.lineIds.filter((id) => id !== lineId);
      this.owner.delete(lineId);
      return null;
    }
    this.forget(entry.id);
    this.gone.set(lineId, entry);
    // A Map keeps insertion order: over the limit, drop the oldest.
    if (this.gone.size > GONE_LIMIT) this.gone.delete(this.gone.keys().next().value);
    return entry;
  }

  // The user dismissed an entry: it is not drawn again, and neither is the same issue elsewhere.
  //   id  an entry id (from a card in the task pane) or a document line id (from Word's
  //       popup). The line itself may already be gone (see gone above), so all are tried.
  // Returns the ids of the lines to delete from the document (this entry's, and those of
  // the same issue elsewhere).
  dismiss(id) {
    const entry = this.issues.get(id) ?? this.entryOfLine(id) ?? this.gone.get(id);
    if (!entry) return [];
    const key = issueKey(entry.match);
    this.dismissed.add(key);
    const lines = [...entry.lineIds];
    for (const other of [...this.issues.values()]) {
      if (issueKey(other.match) !== key) continue;
      lines.push(...other.lineIds);
      this.forget(other.id);
    }
    return [...new Set(lines)];
  }

  // Entries for the task pane's list: only those of the paragraphs on screen, in document order.
  //   paragraphIds  ids of the paragraphs on screen, in document order
  visibleIssues(paragraphIds) {
    const order = new Map(paragraphIds.map((id, index) => [id, index]));
    return [...this.issues.values()]
      .filter((issue) => order.has(issue.paragraphId))
      .sort((a, b) => order.get(a.paragraphId) - order.get(b.paragraphId) || a.start - b.start || (a.match.rule_id === HINT_RULE ? -1 : 1));
  }
}
