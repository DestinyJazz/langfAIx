// The badge in the corner of a field opens a menu with three choices. This works out
// which text each choice would send to the AI:
//
//   sentence    the sentence the caret is in
//   selection   the selected text (absent when nothing is selected)
//   all         all the text in the field
//
// Nothing is sent here. Text only leaves when the user picks a menu item.

import { sentenceAt } from "./sentence.js";

// The most one AI rewrite may send. Same values as the backend defaults (AI_MAX_TEXT_CHARS
// and AI_MAX_SENTENCES). Checking here lets the menu say "too long" without a round trip.
// The server has the final word: if its limits change and these do not, its answer is
// shown on the card as is.
export const MAX_AI_CHARS = 5000;
export const MAX_AI_SENTENCES = 30;

// Trim whitespace from both ends of a range. Null if nothing is left.
function trimmed(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { offset: start, length: end - start } : null;
}

// How many sentences a range touches.
function countSentences(ranges, offset, length) {
  const end = offset + length;
  return (ranges ?? []).filter((range) => range.offset < end && range.offset + range.length > offset).length;
}

// The message shown when over the limit; an empty string otherwise.
export function blockedReason(length, sentences) {
  const number = (value) => value.toLocaleString("en-US");
  if (length > MAX_AI_CHARS) return `Too long: ${number(length)} characters (the limit is ${number(MAX_AI_CHARS)}).`;
  if (sentences > MAX_AI_SENTENCES) return `Too many sentences: ${sentences} (the limit is ${MAX_AI_SENTENCES}).`;
  return "";
}

function scope(ranges, range) {
  if (!range) return null;
  const sentences = Math.max(1, countSentences(ranges, range.offset, range.length));
  return { offset: range.offset, length: range.length, sentences, blocked: blockedReason(range.length, sentences) };
}

// Work out the three choices.
//   text       the whole text of the field
//   ranges     sentence boundaries (see sentenceRanges in lib/sentence.js)
//   selection  caret or selection { start, end }; start equals end for a caret. Null if none
// Returns { sentence, selection, all }. Each is null (no such choice) or
// { offset, length, sentences, blocked }:
//   sentences  roughly how many sentences, for the cost estimate
//   blocked    the over-the-limit message; non-empty means the item cannot be clicked
export function buildScopes(text, ranges, selection) {
  const caret = selection ? selection.start : 0;
  const hasSelection = Boolean(selection) && selection.end > selection.start;
  return {
    sentence: scope(ranges, sentenceAt(ranges, caret)),
    selection: hasSelection ? scope(ranges, trimmed(text, selection.start, selection.end)) : null,
    all: scope(ranges, trimmed(text, 0, text.length)),
  };
}
