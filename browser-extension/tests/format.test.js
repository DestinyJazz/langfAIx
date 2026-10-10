// Tests for how tokens and cost are displayed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCostLine, formatEstimate, formatModelLine, formatTotalLine, formatUsage, formatUsd } from "../lib/format.js";

const DOT = " · ";
const usage = (prompt, cached, completion) => ({
  prompt_tokens: prompt,
  cached_tokens: cached,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

test("amounts are shown in US dollars with four decimals", () => {
  assert.equal(formatUsd(0.001), "US$0.0010");
  assert.equal(formatUsd(0.0007), "US$0.0007");
  assert.equal(formatUsd(0.00025), "US$0.0003"); // rounded
  assert.equal(formatUsd(1.5), "US$1.5000");
});

test("very small amounts do not become a long string of zeros", () => {
  assert.equal(formatUsd(0.00004), "< US$0.0001");
  assert.equal(formatUsd(0.0000001), "< US$0.0001");
});

test("exactly zero is shown as zero", () => {
  assert.equal(formatUsd(0), "US$0.0000");
});

test("an unknown amount shows nothing", () => {
  assert.equal(formatUsd(null), "");
  assert.equal(formatUsd(undefined), "");
  assert.equal(formatUsd(Number.NaN), "");
});

test("an estimate says it is approximate", () => {
  assert.equal(formatEstimate(0.00031), "about US$0.0003");
  assert.equal(formatEstimate(0.00004), "< US$0.0001"); // already "less than": no "about"
});

test("no estimate is shown when there is no data yet", () => {
  assert.equal(formatEstimate(null), "");
  assert.equal(formatEstimate(undefined), "");
});

test("usage shows the total and its breakdown", () => {
  assert.equal(formatUsage(usage(410, 300, 110)), "520 tokens (in 410, cached 300 / out 110)");
});

test("the cached part is left out when nothing was cached", () => {
  assert.equal(formatUsage(usage(410, 0, 110)), "520 tokens (in 410 / out 110)");
});

test("cost line for a sentence with changes", () => {
  const sentence = { status: "changed", usage: usage(410, 300, 110), cost: { usd: 0.001, self_hosted: false } };
  assert.equal(formatCostLine(sentence), `520 tokens (in 410, cached 300 / out 110)${DOT}US$0.0010`);
});

test("cost line for a sentence that needed no change", () => {
  // No edits still cost money, so the line is shown.
  const sentence = { status: "unchanged", usage: usage(400, 0, 10), cost: { usd: 0.0007, self_hosted: false } };
  assert.equal(formatCostLine(sentence), `AI checked, no change needed${DOT}410 tokens${DOT}US$0.0007`);
});

test("a self-hosted model shows tokens but no money", () => {
  const sentence = { status: "changed", usage: usage(50, 0, 5), cost: { usd: null, self_hosted: true } };
  assert.equal(formatCostLine(sentence), `55 tokens (in 50 / out 5)${DOT}self-hosted model`);
});

test("when the cost is unknown only the tokens are shown", () => {
  const sentence = { status: "changed", usage: usage(50, 0, 5), cost: { usd: null, self_hosted: false } };
  assert.equal(formatCostLine(sentence), "55 tokens (in 50 / out 5)");
});

test("several sentences get a total line", () => {
  const sentences = [
    { status: "changed", usage: usage(410, 300, 110), cost: { usd: 0.001, self_hosted: false } },
    { status: "unchanged", usage: usage(410, 300, 10), cost: { usd: 0.0007, self_hosted: false } },
    { status: "error", usage: null, cost: null }, // the failed sentence has no usage and is not counted
  ];
  assert.equal(formatTotalLine(sentences), `Total for 2 sentences${DOT}940 tokens${DOT}US$0.0017`);
});

test("one sentence needs no total line", () => {
  assert.equal(formatTotalLine([{ status: "changed", usage: usage(410, 0, 110), cost: { usd: 0.001 } }]), "");
  assert.equal(formatTotalLine([]), "");
  assert.equal(formatTotalLine(undefined), "");
});

test("the total shows no amount when one of the costs is unknown", () => {
  const sentences = [
    { usage: usage(100, 0, 10), cost: { usd: 0.001, self_hosted: false } },
    { usage: usage(100, 0, 10), cost: { usd: null, self_hosted: false } },
  ];
  assert.equal(formatTotalLine(sentences), `Total for 2 sentences${DOT}220 tokens`);
});

test("the total for a self-hosted model shows tokens only", () => {
  const sentences = [
    { usage: usage(100, 0, 10), cost: { usd: null, self_hosted: true } },
    { usage: usage(100, 0, 10), cost: { usd: null, self_hosted: true } },
  ];
  assert.equal(formatTotalLine(sentences), `Total for 2 sentences${DOT}220 tokens${DOT}self-hosted model`);
});

test("a failed call has no cost line", () => {
  assert.equal(formatCostLine({ status: "error", usage: null, cost: null }), "");
  assert.equal(formatCostLine(null), "");
});

test("formatModelLine names the model, or stays empty when the server did not say", () => {
  assert.equal(formatModelLine("langfAIx-model-1"), "Model: langfAIx-model-1");
  assert.equal(formatModelLine("  o4-mini "), "Model: o4-mini");
  // An older server sends no model name: the line is left out.
  for (const missing of [undefined, null, "", "   ", 42]) assert.equal(formatModelLine(missing), "");
});
