// Sentence boundaries: which sentences a text was split into, and which one a position is in.
//
// Purpose: an AI rewrite sends only the sentence the user cares about, not the whole
// text. That costs less and sends less.
//
// The boundaries come from the server's /check (LanguageTool splits; see sentences.py in
// the backend). Positions are JavaScript string indexes, as everywhere else.

// Usable sentence ranges.
//   text       the whole text of the field
//   sentences  the sentences in the /check response, each { offset, length }
// An older server gives no boundaries: fall back to one sentence per line. A line may
// hold several sentences; the backend splits again on its side.
export function sentenceRanges(text, sentences) {
  const valid = (sentences ?? []).filter(
    (s) => Number.isInteger(s.offset) && Number.isInteger(s.length) && s.length > 0 && s.offset >= 0 && s.offset + s.length <= text.length,
  );
  if (valid.length > 0) return valid.map((s) => ({ offset: s.offset, length: s.length })).sort((a, b) => a.offset - b.offset);

  const ranges = [];
  let position = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      const leading = line.length - line.trimStart().length;
      ranges.push({ offset: position + leading, length: trimmed.length });
    }
    position += line.length + 1; // +1 for the line break
  }
  return ranges;
}

// ---------- Free hints: which sentences "could read better" ----------
//
// No AI is called here. Only what the rule check already returned for free is used to
// guess whether a sentence is worth showing to the AI. A right guess costs money only
// when the user clicks; a wrong one costs a lavender line. So the AI entry point can
// appear by itself, yet nothing is spent or sent before the user clicks.

// This many places with rule issues suggest the sentence needs rewriting, not word fixes.
const MANY_ISSUES = 2;
// More words than this is a long sentence, which can usually be split or tightened.
const LONG_SENTENCE_WORDS = 30;
// Too short to rewrite: no hint.
const MIN_WORDS = 5;
// LanguageTool categories about style, not correctness: wordiness, colloquialisms, repetition.
const STYLE_CATEGORIES = new Set(["STYLE", "REDUNDANCY", "PLAIN_ENGLISH", "REPETITIONS_STYLE", "COLLOQUIALISMS", "CREATIVE_WRITING"]);

function countWords(text) {
  const words = text.trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

// Count the places with rule issues. Adjacent grammar issues (at most one space apart)
// count as one place: LanguageTool often reports one grammar error as two neighbours,
// e.g. "This are" as This and are. That is one error and should not make the sentence
// look full of issues. Misspellings are not merged: three typos in a row are three.
function countSpots(matches) {
  const sorted = [...matches].sort((a, b) => a.offset - b.offset);
  let spots = 0;
  let previous = null;
  let previousEnd = -Infinity;
  for (const match of sorted) {
    const touching = match.offset <= previousEnd + 1;
    const sameMistake = touching && match.issue_type !== "misspelling" && previous.issue_type !== "misspelling";
    if (!sameMistake) spots++;
    previous = match;
    previousEnd = Math.max(previousEnd, match.offset + match.length);
  }
  return spots;
}

// Whether a sentence deserves a hint. Returns the reason, or an empty string.
//   sentenceText       the sentence
//   matchesInSentence  the rule issues inside it
// The reason is one of issues (many issues), style, long.
export function hintReason(sentenceText, matchesInSentence) {
  const words = countWords(sentenceText);
  if (words < MIN_WORDS) return "";
  if (countSpots(matchesInSentence) >= MANY_ISSUES) return "issues";
  if (matchesInSentence.some((m) => m.issue_type === "style" || STYLE_CATEGORIES.has(m.category))) return "style";
  if (words >= LONG_SENTENCE_WORDS) return "long";
  return "";
}

// Find the sentences to hint.
//   text      the whole text
//   ranges    sentence boundaries
//   matches   rule issues
//   skip      a function: given a sentence's text, answers "do not hint this one" (the AI
//             already looked at it, or the user dismissed it)
// Each result is { offset, length, text, reason }.
export function findHints(text, ranges, matches, skip = () => false) {
  const hints = [];
  for (const range of ranges ?? []) {
    const end = range.offset + range.length;
    const sentenceText = text.slice(range.offset, end);
    if (skip(sentenceText)) continue;
    const inside = (matches ?? []).filter((m) => m.offset >= range.offset && m.offset < end);
    const reason = hintReason(sentenceText, inside);
    if (reason) hints.push({ offset: range.offset, length: range.length, text: sentenceText, reason });
  }
  return hints;
}

// The sentence containing a position. In the whitespace between two sentences, the one
// before. Null when there are no sentences.
export function sentenceAt(ranges, offset) {
  let previous = null;
  for (const range of ranges ?? []) {
    if (offset < range.offset) break;
    if (offset < range.offset + range.length) return range;
    previous = range;
  }
  // offset is after one sentence and before the next, or right at the end of the last one.
  return previous ?? (ranges && ranges.length > 0 ? ranges[0] : null);
}
