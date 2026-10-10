// After a paragraph is checked: work out which lines to draw.
//   red lines        rule issues
//   lavender lines   "this sentence could read better" hints
//
// Hints call no AI. They are computed locally from what the rule check returned for free
// (where the issues are, where sentences end): two or more places with errors, a style
// rule, or a very long sentence. The algorithm is the browser extension's lib/sentence.js.
//
// Two colours cannot be stacked: tried in real Word, the red line does not show under a
// lavender one. So the lavender line breaks where a red one is, and one sentence's hint
// becomes several short pieces. The cutting is the extension's lib/segments.js.
//
// Computation only; no Word calls, so this is testable without Word.

import { splitIntoLayers } from "../../browser-extension/lib/segments.js";
import { findHints } from "../../browser-extension/lib/sentence.js";

// Work out what to draw for one paragraph.
//   text       the paragraph's text
//   issues     its rule issues, each { start, length, match } (positions in the paragraph)
//   sentences  its sentence boundaries, each { offset, length }
//   skip       a function: given a sentence, answers "do not hint this one"
// Returns { issues, hints }:
//   issues  unchanged
//   hints   each { offset, length, text, reason, pieces }; pieces are the short stretches
//           of the hint line, each { start, length }
export function layersFor(text, issues, sentences, skip = () => false) {
  // The extension's functions expect { offset, length, issue_type, category }.
  const matches = issues.map((issue) => ({ offset: issue.start, length: issue.length, issue_type: issue.match.issue_type, category: issue.match.category }));
  const hints = findHints(text, sentences, matches, skip).map((hint) => ({ ...hint, pieces: [] }));
  if (hints.length === 0) return { issues, hints };

  let position = 0;
  for (const segment of splitIntoLayers(text, matches, hints)) {
    // A segment that is not a rule issue and lies in a hint is one stretch of lavender line.
    if (!segment.match && segment.hint) segment.hint.pieces.push({ start: position, length: segment.text.length });
    position += segment.text.length;
  }
  return { issues, hints };
}
