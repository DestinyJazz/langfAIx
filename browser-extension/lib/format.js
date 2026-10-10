// How the tokens and the cost of an AI call are displayed:
//
//   with edits     520 tokens (in 410, cached 300 / out 110) · US$0.0010
//   without edits  AI checked, no change needed · 410 tokens · US$0.0007
//
// USD only, four decimals; below 0.0001 it reads < US$0.0001 instead of a long fraction.

const SEPARATOR = " · "; // the small dot in the middle

// The amount. usd is a number, or null when unknown, which gives an empty string.
export function formatUsd(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "";
  if (usd > 0 && usd < 0.0001) return "< US$0.0001";
  return `US$${usd.toFixed(4)}`;
}

// The "about this much" text next to the button on the hint card, e.g. about US$0.0003.
// Empty without data. Tiny amounts already read < US$0.0001 and get no "about".
export function formatEstimate(usd) {
  const amount = formatUsd(usd);
  if (!amount) return "";
  return amount.startsWith("<") ? amount : `about ${amount}`;
}

// Token detail: the total, then input, cached input and output in brackets.
export function formatUsage(usage) {
  if (!usage) return "";
  const cached = usage.cached_tokens > 0 ? `, cached ${usage.cached_tokens}` : "";
  return `${usage.total_tokens} tokens (in ${usage.prompt_tokens}${cached} / out ${usage.completion_tokens})`;
}

// The cost part. A self-hosted model has no per-token billing: say so instead of an amount.
function costPart(cost) {
  if (!cost) return "";
  if (cost.self_hosted) return "self-hosted model";
  return formatUsd(cost.usd);
}

// The total line under several sentences, e.g. Total for 3 sentences · 1460 tokens · US$0.0021.
// Empty for a single sentence. If any sentence has no amount, the total shows none either,
// so it never understates.
export function formatTotalLine(sentences) {
  const counted = (sentences ?? []).filter((sentence) => sentence && sentence.usage);
  if (counted.length < 2) return "";
  const tokens = counted.reduce((sum, sentence) => sum + (sentence.usage.total_tokens ?? 0), 0);
  const parts = [`Total for ${counted.length} sentences`, `${tokens} tokens`];
  if (counted.every((sentence) => sentence.cost?.self_hosted)) {
    parts.push("self-hosted model");
  } else if (counted.every((sentence) => typeof sentence.cost?.usd === "number")) {
    parts.push(formatUsd(counted.reduce((sum, sentence) => sum + sentence.cost.usd, 0)));
  }
  return parts.join(SEPARATOR);
}

// The line naming the model at the bottom of the AI card, e.g. Model: langfAIx-model-1.
// The name comes from the server; an older server sends none, and the line is left out.
export function formatModelLine(model) {
  const name = typeof model === "string" ? model.trim() : "";
  return name ? `Model: ${name}` : "";
}

// The cost line of one sentence (an item of sentences in the /ai/improve response).
export function formatCostLine(sentence) {
  if (!sentence || !sentence.usage) return "";
  const parts = [];
  if (sentence.status === "unchanged") {
    // Without edits: the short form, with a note in front.
    parts.push("AI checked, no change needed", `${sentence.usage.total_tokens} tokens`);
  } else {
    parts.push(formatUsage(sentence.usage));
  }
  const cost = costPart(sentence.cost);
  if (cost) parts.push(cost);
  return parts.join(SEPARATOR);
}
