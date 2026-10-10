// Cuts text into segments by where the issues are, for drawing underlines.
//
// Input: the text and the matches from the backend's /check (each has offset and length).
// Output: segments in order, each either plain text (match is null) or one issue. Joining
// the text of all segments gives the original text.
//
// Offsets and lengths are UTF-16 code units, i.e. JavaScript string indexes, so slice
// works directly.

export function splitIntoSegments(text, matches) {
  // By position; at the same position the longer range first.
  const sorted = [...(matches ?? [])]
    .filter((m) => Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length > 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  const segments = [];
  let cursor = 0; // how far into the text we are

  for (const match of sorted) {
    const start = match.offset;
    const end = match.offset + match.length;
    // Skip ranges outside the text or overlapping the previous issue. Only the first of two
    // overlapping issues is drawn: stacked underlines cannot be clicked apart.
    if (start < cursor || end > text.length) continue;

    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: null });
    segments.push({ text: text.slice(start, end), match });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: null });
  return segments;
}

// Like splitIntoSegments, with one more layer: the sentences that get a lavender hint line.
//
// Each segment is { text, match, hint }:
//   match  the issue, when this segment is a rule issue; otherwise null
//   hint   the hint, when this segment lies in a hinted sentence; otherwise null
// Drawing: match gets a red squiggle; hint without match gets a lavender dashed line. So
// the lavender line breaks where a red one is, and no word carries both.
//
// Segments of only spaces and punctuation get no hint line (the space between two red
// lines, the period after one). They would show as stray purple dots.

// At least one letter or digit, in any script.
const HAS_WORD = /[\p{L}\p{N}]/u;

export function splitIntoLayers(text, matches, hints) {
  const sortedHints = [...(hints ?? [])].sort((a, b) => a.offset - b.offset);
  const result = [];
  let position = 0; // where the current segment starts in the text

  for (const segment of splitIntoSegments(text, matches)) {
    const start = position;
    const end = position + segment.text.length;
    position = end;

    if (segment.match) {
      // A rule issue is kept whole. Its hint (if any) is recorded for debugging only.
      const hint = sortedHints.find((h) => start >= h.offset && start < h.offset + h.length) ?? null;
      result.push({ text: segment.text, match: segment.match, hint });
      continue;
    }

    // Plain text is cut again at hint boundaries: it may be half inside a hint.
    let cursor = start;
    for (const hint of sortedHints) {
      const hintStart = Math.max(hint.offset, start);
      const hintEnd = Math.min(hint.offset + hint.length, end);
      if (hintStart >= hintEnd || hintStart < cursor) continue; // no overlap with this segment
      if (hintStart > cursor) result.push({ text: text.slice(cursor, hintStart), match: null, hint: null });
      const piece = text.slice(hintStart, hintEnd);
      result.push({ text: piece, match: null, hint: HAS_WORD.test(piece) ? hint : null });
      cursor = hintEnd;
    }
    if (cursor < end) result.push({ text: text.slice(cursor, end), match: null, hint: null });
  }
  return result;
}

// Apply one issue: replace the range match points to and return the new text.
export function applyReplacement(text, match, replacement) {
  return text.slice(0, match.offset) + replacement + text.slice(match.offset + match.length);
}
