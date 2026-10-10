// Estimates what one AI-rewritten sentence costs, shown next to the button on the hint card.
//
// The method is simple: the average of what earlier AI calls on this computer really
// cost. No model prices are needed, and the average follows a change of model by itself.
// With no calls yet there is no estimate.
//
// Stored in chrome.storage.local as two numbers: sentences counted and their total in USD.

export const EMPTY_STATS = { sentences: 0, usd: 0 };

// Above this many sentences both numbers are halved. The average stays the same but old
// calls weigh less. Otherwise, after a thousand sentences, a switch to a model ten times
// the price would take very long to show.
const FORGET_ABOVE = 40;

// Add one /ai/improve response to the stats and return the new stats. Only sentences with
// an amount count: self-hosted models and failed sentences have none.
export function addToStats(stats, improveData) {
  const next = { sentences: stats?.sentences ?? 0, usd: stats?.usd ?? 0 };
  for (const sentence of improveData?.sentences ?? []) {
    const usd = sentence?.cost?.usd;
    if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
      next.sentences += 1;
      next.usd += usd;
    }
  }
  if (next.sentences > FORGET_ABOVE) {
    next.sentences /= 2;
    next.usd /= 2;
  }
  return next;
}

// Average USD per sentence, or null without data.
export function averageUsd(stats) {
  if (!stats || !(stats.sentences > 0)) return null;
  return stats.usd / stats.sentences;
}
