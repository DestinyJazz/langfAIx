// A fake AI for the screenshot tests.
//
// The real AI needs a virtual key and costs money per call. This stands in with a fixed
// table of typos and answers in exactly the format of the backend's /ai/improve, so every
// state of the AI card can be tested for free.

const FAKE_FIXES = [
  ["This are", "These are", "The verb is plural, so the subject must be plural too."],
  ["sentense", "sentence", "Spelling."],
  ["It have", "It has", "The subject is singular."],
  ["erors", "errors", "Spelling."],
  ["secend", "second", "Spelling."],
  ["dont", "does not", "The apostrophe is missing; the full form reads better here."],
  ["documant", "document", "Spelling."],
  ["friday", "Friday", "Days of the week are capitalized."],
  // From the long sentence in D1 of the test page. It stays long after the edit, to test that a sentence the AI edited gets no more hints.
  ["installs it", "install it", "After 'recommends that', the verb takes its base form."],
];

// Stands in for the reply to an improve message sent to the background script.
export function fakeImprove(text) {
  // Two kinds of failure, each triggered by a particular typo.
  if (text.includes("trafic")) {
    return { ok: false, status: 400, error: "Budget has been exceeded! Current cost: 1.02, Max budget: 1.0" };
  }
  if (text.includes("detials")) {
    return { ok: false, error: "The API key is not set. Open the extension options to set it." };
  }

  // Like the real backend: split into sentences, one call each, each with its own edits and
  // cost. Edit positions are relative to the whole text sent, not to the sentence.
  const sentences = splitSentences(text).map((range) => {
    const piece = text.slice(range.offset, range.offset + range.length);
    const edits = [];
    for (const [wrong, right, reason] of FAKE_FIXES) {
      const at = piece.indexOf(wrong);
      if (at !== -1) edits.push({ offset: range.offset + at, length: wrong.length, original: wrong, replacement: right, reason });
    }
    edits.sort((a, b) => a.offset - b.offset);
    const changed = edits.length > 0;
    return {
      offset: range.offset,
      length: range.length,
      text: piece,
      status: changed ? "changed" : "unchanged",
      edits,
      dropped_edits: 0,
      // With edits: the figures of the example in the cost display spec.
      usage: changed
        ? { prompt_tokens: 410, cached_tokens: 300, completion_tokens: 110, total_tokens: 520 }
        : { prompt_tokens: 410, cached_tokens: 300, completion_tokens: 10, total_tokens: 420 },
      cost: { usd: changed ? 0.001 : 0.00007, source: "usage", litellm_usd: changed ? 0.001 : 0.00007, self_hosted: false },
      error: null,
    };
  });

  return { ok: true, data: { model: "fake-model", sentences } };
}

// A very simple sentence splitter: break at period, question mark, exclamation mark or
// line break. Only used when the server returns no sentence boundaries (an old backend).
export function splitSentences(text) {
  const ranges = [];
  let start = 0;
  const push = (end) => {
    const piece = text.slice(start, end);
    const trimmed = piece.trim();
    if (trimmed) ranges.push({ offset: start + piece.indexOf(trimmed), length: trimmed.length });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const isLineBreak = char.charCodeAt(0) === 10;
    const endsSentence = (char === "." || char === "!" || char === "?") && (i + 1 === text.length || text[i + 1] === " " || text.charCodeAt(i + 1) === 10);
    if (isLineBreak || endsSentence) push(i + 1);
  }
  push(text.length);
  return ranges;
}
