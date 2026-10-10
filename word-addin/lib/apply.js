// Before AI edits are applied to a Word paragraph: work out which occurrence to replace.
//
// The difficulty: an AI edit has a position (start and length), but Word's API cannot
// fetch text by position. It can only search a paragraph for some text, which returns
// every occurrence. So we compute which occurrence of that text is the one to replace.
//
// Example: in "the cat and the dog", to replace the second "the": searching "the" gives
// two results and we want number 2.
//
// Computation only; no Word calls, so this is testable without Word.

// Word's search accepts at most this many characters.
export const MAX_SEARCH_LENGTH = 255;

// All positions of needle in text, left to right, non-overlapping. Word's search counts the same way.
function occurrences(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

// Work out how to apply each edit.
//   paragraphText  the paragraph's current text
//   baseOffset     where the text sent to the AI starts in the paragraph
//   edits          the AI's edits, each { offset, length, original, replacement }, offset
//                  relative to the text that was sent
// Returns { steps, skipped }:
//   steps    applicable edits, each { original, replacement, occurrence, offset }.
//            occurrence is 0-based. Ordered last to first, so the positions and occurrence
//            numbers of earlier edits do not shift.
//   skipped  how many cannot be applied: the text at that position is no longer the
//            original (the user changed it), it contains a character special to Word's
//            search, it is too long, or it overlaps another edit.
export function planEdits(paragraphText, baseOffset, edits) {
  const steps = [];
  let skipped = 0;
  let floor = Infinity; // start of the previous (later) edit, to detect overlaps
  const sorted = [...(edits ?? [])].sort((a, b) => b.offset - a.offset);
  for (const edit of sorted) {
    const offset = baseOffset + edit.offset;
    const original = edit.original ?? "";
    const usable =
      original.length > 0 &&
      original.length <= MAX_SEARCH_LENGTH &&
      // ^ is special in Word's search (^p is a paragraph mark), so searching with it is unreliable.
      !original.includes("^") &&
      offset >= 0 &&
      offset + original.length <= floor &&
      // Is the text at that position still what was sent?
      paragraphText.slice(offset, offset + original.length) === original;
    const occurrence = usable ? occurrences(paragraphText, original).indexOf(offset) : -1;
    if (occurrence === -1) {
      skipped++;
      continue;
    }
    steps.push({ original, replacement: edit.replacement ?? "", occurrence, offset });
    floor = offset;
  }
  return { steps, skipped };
}
