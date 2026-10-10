// Which part of each paragraph the user's selection covers.
//
// An AI rewrite must know where each piece of sent text sits (paragraph, start, length) to
// put the result back. Word gives: the paragraphs the selection touches, the selected
// text (paragraphs separated by paragraph marks), and where the selection starts in the
// first paragraph. This lines them up.
//
// Computation only; no Word calls, so this is testable without Word.

// Trim whitespace from both ends of a range. Null if nothing is left.
function trimmed(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { offset: start, length: end - start } : null;
}

// The selected part of each paragraph.
//   paragraphs  the paragraphs the selection touches, each { id, text }, in document order
//   start       where the selection starts in the first paragraph
//   selected    the selected text; across paragraphs Word separates them with \r
// Returns [{ paragraphId, text, offset, length }], one per paragraph (paragraphs whose
// selected part is only whitespace are left out). Returns null when things do not line
// up, e.g. table cell marks or pictures. Better to say "cannot handle this selection"
// than to guess a position.
export function selectionParts(paragraphs, start, selected) {
  const pieces = String(selected ?? "").split(/\r\n|\r|\n/);
  // A selection ending on a paragraph mark leaves an empty last piece, which is not a paragraph.
  if (pieces.length > 1 && pieces.at(-1) === "") pieces.pop();
  if (pieces.length > paragraphs.length) return null;

  const parts = [];
  for (const [index, piece] of pieces.entries()) {
    const paragraph = paragraphs[index];
    const from = index === 0 ? start : 0;
    // The characters at `from` in this paragraph must be exactly this piece.
    if (paragraph.text.slice(from, from + piece.length) !== piece) return null;
    const range = trimmed(paragraph.text, from, from + piece.length);
    if (range) parts.push({ paragraphId: paragraph.id, text: paragraph.text, offset: range.offset, length: range.length });
  }
  return parts;
}
