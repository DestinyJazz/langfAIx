// Turns a sentence plus the AI's suggested edits into the pieces shown on the card.
//
// The card shows the original sentence with deleted text struck through in red and added
// text in blue.
//
// Input:
//   text    the original sentence
//   edits   [{ offset, length, replacement }], offset relative to the start of text
// Output: pieces in order, each { type, text } with type same, removed or added.

// Sort edits by position and drop out-of-range and overlapping ones.
function usableEdits(text, edits) {
  const sorted = [...(edits ?? [])]
    .filter((e) => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.offset >= 0 && e.length >= 0 && e.offset + e.length <= text.length)
    .sort((a, b) => a.offset - b.offset);
  const result = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.offset < cursor) continue; // overlaps the previous edit
    result.push(edit);
    cursor = edit.offset + edit.length;
  }
  return result;
}

export function diffSegments(text, edits) {
  const segments = [];
  let cursor = 0;
  for (const edit of usableEdits(text, edits)) {
    if (edit.offset > cursor) segments.push({ type: "same", text: text.slice(cursor, edit.offset) });
    if (edit.length > 0) segments.push({ type: "removed", text: text.slice(edit.offset, edit.offset + edit.length) });
    if (edit.replacement) segments.push({ type: "added", text: edit.replacement });
    cursor = edit.offset + edit.length;
  }
  if (cursor < text.length) segments.push({ type: "same", text: text.slice(cursor) });
  return segments;
}

// Apply all edits and return the resulting sentence.
export function applyEdits(text, edits) {
  let result = "";
  let cursor = 0;
  for (const edit of usableEdits(text, edits)) {
    result += text.slice(cursor, edit.offset) + (edit.replacement ?? "");
    cursor = edit.offset + edit.length;
  }
  return result + text.slice(cursor);
}

// Edits ordered last to first. Applying them to a field must start at the end, so the
// positions of earlier edits are not shifted.
export function lastToFirst(text, edits) {
  return usableEdits(text, edits).reverse();
}
