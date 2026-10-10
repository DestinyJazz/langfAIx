// Decides which underline the pointer is on.
//
// marks are the underlines currently drawn, each { match, hint, rect }: a red squiggle
// carries match (the rule issue), a lavender hint line carries hint. rect is the screen
// rectangle of that text { left, top, right, bottom }; x and y use the same coordinates.
// Returns the mark under the pointer, or null.

// Extend each rectangle a few pixels down: the squiggle is drawn below the text, partly
// outside the text's own rectangle, and pointing at the line itself should count.
const SLACK_BELOW = 4;

export function findHit(marks, x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const mark of marks ?? []) {
    const { left, top, right, bottom } = mark.rect;
    if (x < left || x > right || y < top || y > bottom + SLACK_BELOW) continue;
    // Where two underlines overlap, the smaller one wins: it is more specific.
    const area = (right - left) * (bottom - top);
    if (area < bestArea) {
      best = mark;
      bestArea = area;
    }
  }
  return best;
}

// The identity of an issue, used to remember dismissed ones: rule plus the flagged text,
// so the same word elsewhere is hidden as well.
export function matchKey(match) {
  return `${match.rule_id}\n${match.text}`;
}
