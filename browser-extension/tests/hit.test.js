// Tests for deciding which squiggle the pointer is on.

import assert from "node:assert/strict";
import { test } from "node:test";

import { findHit, matchKey } from "../lib/hit.js";

const mark = (name, left, top, right, bottom) => ({ match: { name }, rect: { left, top, right, bottom } });

test("a point inside a mark hits it", () => {
  const marks = [mark("a", 10, 10, 50, 26), mark("b", 60, 10, 100, 26)];
  assert.equal(findHit(marks, 20, 15).match.name, "a");
  assert.equal(findHit(marks, 80, 20).match.name, "b");
});

test("a point outside every mark hits nothing", () => {
  const marks = [mark("a", 10, 10, 50, 26)];
  assert.equal(findHit(marks, 55, 15), null); // the gap between two words
  assert.equal(findHit(marks, 20, 5), null); // above the text
  assert.equal(findHit(marks, 20, 40), null); // far below the text
});

test("the wavy line just below the text still counts", () => {
  // The text rectangle ends at 26; the squiggle is drawn from 27 to 30.
  const marks = [mark("a", 10, 10, 50, 26)];
  assert.equal(findHit(marks, 20, 29).match.name, "a");
  assert.equal(findHit(marks, 20, 31), null);
});

test("a word wrapped onto two lines can be hit on either line", () => {
  const match = { name: "wrapped" };
  const marks = [
    { match, rect: { left: 200, top: 10, right: 260, bottom: 26 } },
    { match, rect: { left: 10, top: 30, right: 40, bottom: 46 } },
  ];
  assert.equal(findHit(marks, 250, 15).match, match);
  assert.equal(findHit(marks, 20, 40).match, match);
});

test("when two marks overlap the smaller one wins", () => {
  const marks = [mark("whole phrase", 10, 10, 200, 26), mark("one word", 60, 10, 100, 26)];
  assert.equal(findHit(marks, 80, 15).match.name, "one word");
  assert.equal(findHit(marks, 150, 15).match.name, "whole phrase");
});

test("no marks means no hit", () => {
  assert.equal(findHit([], 10, 10), null);
  assert.equal(findHit(undefined, 10, 10), null);
});

test("matchKey is the same for the same word and rule anywhere in the text", () => {
  const first = { rule_id: "MORFOLOGIK_RULE_EN_US", text: "Zyphor", offset: 3 };
  const second = { rule_id: "MORFOLOGIK_RULE_EN_US", text: "Zyphor", offset: 90 };
  const other = { rule_id: "MORFOLOGIK_RULE_EN_US", text: "Qorvex", offset: 3 };
  assert.equal(matchKey(first), matchKey(second));
  assert.notEqual(matchKey(first), matchKey(other));
});
