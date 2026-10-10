// Joins a batch of Word paragraphs into one text for checking, and maps the results back
// to the paragraphs.
//
// Why join: a page has dozens of paragraphs, and one request each is too slow. Joined,
// a page takes one request. The server's positions are in the joined text, while Word
// draws by "character n of paragraph m", so each paragraph's span in the joined text is
// recorded and subtracted afterwards.
//
// Conversion only; no Word calls, so this is testable without Word.
//
// Positions and lengths are JavaScript string indexes (UTF-16 code units), as in /check.

// What goes between paragraphs. A blank line makes the checker treat them as separate
// paragraphs instead of joining the end of one sentence to the start of the next.
export const SEPARATOR = "\n\n";

// Most text sent in one check. The backend's limit is 20,000; this leaves room.
export const MAX_CHARS = 15000;

// Prepare paragraph text for checking without changing its length (positions must hold).
// A Shift+Enter line break in Word is \v in the text; it becomes a normal line break.
export function forChecking(text) {
  return String(text ?? "").replace(/\u000b/g, "\n");
}

// Special characters Word puts in the text (footnote references, pictures, field marks).
// Invisible but counted, they are the likeliest cause of misplaced squiggles. Returns the
// character codes found, for the log.
export function oddCharacters(text) {
  const found = new Set();
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    // Below 32 are control characters. Tab (9) and the line breaks (10, 11, 13) are normal.
    if ((code < 32 && ![9, 10, 11, 13].includes(code)) || code === 0xfffc) found.add(code);
  }
  return [...found].sort((a, b) => a - b);
}

// Join a batch of paragraphs into one text.
//   paragraphs  each has at least text; other fields (Word's paragraph id) are kept
// Returns { text, spans }:
//   text   the joined text
//   spans  where each non-empty paragraph sits in text: { index, start, end }, index being
//          its position in paragraphs
// Empty (whitespace-only) paragraphs are left out and take no space.
export function joinParagraphs(paragraphs) {
  let text = "";
  const spans = [];
  paragraphs.forEach((paragraph, index) => {
    const body = forChecking(paragraph.text);
    if (!body.trim()) return;
    if (text) text += SEPARATOR;
    spans.push({ index, start: text.length, end: text.length + body.length });
    text += body;
  });
  return { text, spans };
}

// Split into batches when there are too many paragraphs; each batch joins to at most
// limit characters. A paragraph over the limit by itself is its own batch (the backend
// rejects it without affecting the others). Each batch is a list of indexes into paragraphs.
export function chunkParagraphs(paragraphs, limit = MAX_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  paragraphs.forEach((paragraph, index) => {
    const length = forChecking(paragraph.text).length;
    if (!forChecking(paragraph.text).trim()) return;
    const added = length + (current.length > 0 ? SEPARATOR.length : 0);
    if (current.length > 0 && size + added > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(index);
    size += current.length > 1 ? added : length;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Map check results back to paragraphs.
//   spans    from joinParagraphs
//   matches  the matches of the /check response, each with offset and length
// Each result is { index, start, length, match }: the paragraph's index and the position
// inside it. Matches spanning two paragraphs or lying on the blank line between them are
// dropped: they cannot be drawn in Word.
export function locateMatches(spans, matches) {
  const located = [];
  let cursor = 0; // matches and paragraphs are both in order: no need to search from the start each time
  for (const match of [...matches].sort((a, b) => a.offset - b.offset)) {
    while (cursor < spans.length && spans[cursor].end <= match.offset) cursor++;
    const span = spans[cursor];
    if (!span || match.offset < span.start || match.offset + match.length > span.end || match.length <= 0) continue;
    located.push({ index: span.index, start: match.offset - span.start, length: match.length, match });
  }
  return located;
}
