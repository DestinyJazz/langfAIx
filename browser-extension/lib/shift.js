// Moves old check results to their new positions after the user edited the text.
//
// Positions in a result refer to the text at the moment of the check. When the user keeps
// typing, everything after the edit is off. A re-check only happens after a pause
// (debounce), and until then the squiggles must not jump around.
//
// Method: compare old and new text and find the changed stretch in the middle.
//   - an issue entirely before the change: unchanged
//   - an issue entirely after the change: shifted
//   - an issue touching the change: dropped. That word is being edited; wait for the re-check
//
// Positions are JavaScript string indexes, as in the backend.

export function shiftMatches(oldText, newText, matches) {
  if (oldText === newText || !matches || matches.length === 0) return matches ?? [];

  // Length of the common prefix.
  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  // Length of the common suffix (it must not overlap the prefix).
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const editStart = prefix; // where the change starts in the old text
  const editEnd = oldText.length - suffix; // where the change ends in the old text
  const delta = newText.length - oldText.length; // how far text after the change moves

  const result = [];
  for (const match of matches) {
    const start = match.offset;
    const end = match.offset + match.length;
    if (end < editStart) {
      // Before the change and not adjacent to it.
      result.push(match);
    } else if (start > editEnd) {
      // After the change.
      result.push({ ...match, offset: start + delta });
    }
    // Everything else touches the change (adjacent counts) and is dropped. Adjacent counts
    // because typing at the end of a word changes that word.
  }
  return result;
}
