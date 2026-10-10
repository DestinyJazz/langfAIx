// Tests for the estimate of what one AI-rewritten sentence costs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_STATS, addToStats, averageUsd } from "../lib/estimate.js";

const reply = (...costs) => ({ sentences: costs.map((usd) => ({ cost: usd === undefined ? null : { usd } })) });

test("there is no estimate before any call", () => {
  assert.equal(averageUsd(EMPTY_STATS), null);
  assert.equal(averageUsd(undefined), null);
});

test("the estimate is the average of what was actually paid", () => {
  let stats = EMPTY_STATS;
  stats = addToStats(stats, reply(0.0002, 0.0004));
  assert.equal(stats.sentences, 2);
  assert.ok(Math.abs(averageUsd(stats) - 0.0003) < 1e-12);

  stats = addToStats(stats, reply(0.0003));
  assert.equal(stats.sentences, 3);
  assert.ok(Math.abs(averageUsd(stats) - 0.0003) < 1e-12);
});

test("sentences without a price are not counted", () => {
  // A self-hosted model has no amount (usd is null); a failed sentence has no cost at all.
  const stats = addToStats(EMPTY_STATS, reply(null, undefined, 0.0002));
  assert.equal(stats.sentences, 1);
  assert.equal(averageUsd(stats), 0.0002);
});

test("the original stats object is not changed", () => {
  const before = { sentences: 1, usd: 0.0002 };
  addToStats(before, reply(0.0004));
  assert.deepEqual(before, { sentences: 1, usd: 0.0002 });
});

test("after switching to a pricier model the estimate catches up", () => {
  // 1,000 sentences with a cheap model, then 100 with one ten times the price.
  let stats = EMPTY_STATS;
  for (let i = 0; i < 1000; i++) stats = addToStats(stats, reply(0.0002));
  assert.ok(Math.abs(averageUsd(stats) - 0.0002) < 1e-9);
  for (let i = 0; i < 100; i++) stats = addToStats(stats, reply(0.002));
  // A plain average over all of them would be about 0.00036, far from the current real cost.
  assert.ok(averageUsd(stats) > 0.0015, `the estimate is still ${averageUsd(stats)}`);
});

test("a broken reply does not break the stats", () => {
  assert.deepEqual(addToStats(EMPTY_STATS, undefined), EMPTY_STATS);
  assert.deepEqual(addToStats(EMPTY_STATS, {}), EMPTY_STATS);
});
