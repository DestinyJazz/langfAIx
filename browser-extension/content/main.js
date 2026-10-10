// Main part of the content script: watches the field in use, checks it automatically,
// draws squiggles, shows a suggestion card on hover and replaces text on click.
//
// Flow:
//   1. the caret enters a field: start watching it
//   2. the text changes: move the old squiggles to their new positions and start a timer
//   3. after a short pause, send the text to the background script for a check (debounce)
//   4. the result arrives: draw squiggles
//   5. the pointer rests on a squiggle: show the card; a suggestion replaces, Dismiss hides
//   6. the caret leaves the field: remove the squiggles
//
// Three kinds of field are supported: textarea, input, rich-text area. Their differences
// live in the adapters (content/control.js and content/editable.js); this flow is the
// same for all three.
//
// Only the rule check (LanguageTool) runs automatically. An AI rewrite runs only after
// the user clicks: before that, no text goes to the AI and nothing is spent.
//
// Besides red squiggles there are lavender dashes meaning "the AI could improve this
// sentence". They are guessed from the rule-check result (lib/sentence.js), free of charge.
//
// A badge at the bottom right of the field (content/badge.js) shows the number of issues.
// Its menu offers an AI rewrite of the sentence at the caret, the selection or the whole text.

import { applyEdits, diffSegments, lastToFirst } from "../lib/diff.js";
import { covers } from "../lib/dictionary.js";
import { formatCostLine, formatEstimate, formatModelLine, formatTotalLine } from "../lib/format.js";
import { findHit, matchKey } from "../lib/hit.js";
import { buildScopes } from "../lib/scope.js";
import { findHints, sentenceAt, sentenceRanges } from "../lib/sentence.js";
import { shiftMatches } from "../lib/shift.js";
import { Badge } from "./badge.js";
import { createAdapter, findField } from "./fields.js";
import { Overlay } from "./overlay.js";
import { SuggestionPopup } from "./popup.js";

// Pause in typing before a check (ms). Shorter sends a request per keystroke; longer feels sluggish.
const DEBOUNCE_MS = 700;
// Longer text is not checked automatically, so a long document is not resent on every edit.
const MAX_AUTO_CHECK_CHARS = 10000;
// Delay before squiggles are removed after the caret leaves (ms). Users often just click
// a toolbar button (bold) and come straight back; removing and re-checking at once would
// make the squiggles flicker and waste a request.
const LEAVE_DELAY_MS = 250;
// How long the pointer must rest on a squiggle before the card shows, so passing over does not trigger it.
const POPUP_SHOW_DELAY_MS = 150;
// The same for a lavender hint line. It spans a whole sentence and is easily crossed, so the wait is longer.
const HINT_SHOW_DELAY_MS = 400;
// How long after leaving squiggle and card the card hides: time to move from the word onto the card.
const POPUP_HIDE_DELAY_MS = 300;

// Names of the three choices in the badge menu.
const SCOPE_LABELS = {
  sentence: "Improve this sentence",
  selection: "Improve selection",
  all: "Improve whole text",
};
// Shown on the card while waiting for the AI: what was sent.
const SENDING_NOTES = {
  sentence: "Only this sentence is sent.",
  selection: "Only the selected text is sent.",
  all: "The whole text of this box is sent.",
};

// In the AI response, edit positions are relative to the whole text sent. Make them relative to their own sentence.
const relativeEdits = (item) => item.edits.map((edit) => ({ ...edit, offset: edit.offset - item.offset }));

export function start() {
  // The squiggle mirror, shared by textarea and input.
  const overlay = new Overlay();
  const popup = new SuggestionPopup();
  // The corner badge, one per page.
  const badge = new Badge();
  badge.onOpen = () => toggleBadgeMenu();
  // The caret left the card's lookup box: check again whether the user has gone.
  badge.onBlur = () => refreshSoon();
  // The field being watched and its state, or null.
  let session = null;
  let leaveTimer = 0;
  let stopped = false;

  // Issues the user dismissed. Hidden until the page reloads.
  const dismissed = new Set();
  const notDismissed = (matches) => matches.filter((match) => !dismissed.has(matchKey(match)));

  // Sentences that get no hint line any more, identified by their text, until the page reloads:
  //   the user clicked Dismiss on the hint card
  //   the AI looked at the sentence and found nothing to change
  //   the user saw the AI's edits and clicked Dismiss
  //   the user accepted the AI's edits: the result was written by the AI and needs no second look
  const quietSentences = new Set();

  // Draw a field's current issues and hints, and update the badge.
  function draw(current) {
    current.adapter.render(current.text, current.matches, current.hints);
    // The badge needs one successful check first. No server, or text not worth checking: no badge.
    const checked = current.checkedText !== null && current.adapter.shouldCheck(current.text);
    badge.setState({ visible: checked, count: current.matches.length });
  }

  // Whether the team glossary is on (the switch in the settings). The card shows the switch,
  // so the background script is asked once when a field starts being watched.
  let glossaryOn = true;
  let glossaryKnown = false; // known yet? The first answer is only recorded; later changes trigger work
  async function refreshGlossaryState() {
    let on;
    try {
      const response = await chrome.runtime.sendMessage({ type: "glossary-state" });
      if (!response || !response.ok) return;
      on = response.data.on !== false;
    } catch {
      return; // no answer: never mind
    }
    const changed = glossaryKnown && on !== glossaryOn;
    glossaryOn = on;
    glossaryKnown = true;
    if (!changed) return;
    // The switch was changed elsewhere (settings page, or the card on another page): update
    // the tick and re-check at once with the new setting.
    badge.setGlossary(on);
    if (session) scheduleCheck(0);
  }
  // Ask again when the user returns from another tab or window; they may just have changed the switch.
  const onWindowFocus = () => {
    if (session) refreshGlossaryState();
  };

  let estimateUsd = null;
  // "About this much" for that many sentences, as text; empty without data. The figure is
  // the average real spend on this computer, kept by the background script (lib/estimate.js).
  const estimateFor = (sentences) => (estimateUsd === null ? "" : formatEstimate(estimateUsd * sentences));
  async function refreshEstimate() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "estimate" });
      const usd = response && response.ok ? response.data?.usd : null;
      estimateUsd = typeof usd === "number" ? usd : null;
    } catch {
      // The extension was reloaded and cannot answer. The check code is what stops this script.
    }
  }

  // ---------- Which field is the caret in ----------

  // The field the caret is in, or null if it is in none we handle.
  //
  // Focus events alone are not enough: some editors (TinyMCE) put the editing area in an
  // iframe whose whole body is editable. Focus is already on the body when the user clicks
  // in, and the browser may send no event. So this asks directly where focus and caret are,
  // and several kinds of event trigger the question.
  function currentField() {
    // The page (or frame) has no focus at all: the user is elsewhere.
    if (!document.hasFocus()) return null;

    const active = document.activeElement;
    // Still in the same field: the common case, no need to decide again.
    if (session && active && (active === session.field || session.field.contains(active))) return session.field;

    const fromFocus = findField(active);
    if (fromFocus) return fromFocus;

    // Focus is not on a field, but the caret (selection) is inside an editable element.
    const anchor = document.getSelection()?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (element && element.isContentEditable) {
      if (session && session.field.contains(element)) return session.field;
      return findField(element);
    }
    return null;
  }

  // Look where the caret is and decide: start watching, keep watching, or prepare to leave.
  function refresh() {
    if (stopped) return;
    const field = currentField();
    if (field) {
      clearTimeout(leaveTimer);
      leaveTimer = 0;
      activate(field);
    } else if (session && !leaveTimer) {
      leaveTimer = setTimeout(() => {
        leaveTimer = 0;
        // Do not leave while the pointer is on the card or the badge (the user may be about to
        // click), or while the caret is in the card's lookup box (the field has no focus then,
        // but the user has not gone).
        if (!currentField() && !pointerOnPopup && !badge.pointerInside && !badge.hasFocus) deactivate();
      }, LEAVE_DELAY_MS);
    }
  }

  // For some events the browser has not updated the focus yet: look after this event round.
  const refreshSoon = () => setTimeout(refresh, 0);

  function activate(field) {
    if (session && session.field === field) return;
    deactivate();
    const adapter = createAdapter(field, overlay);
    session = {
      field,
      adapter,
      text: adapter.readText(), // the text seen last
      matches: [], // the issues drawn now
      hints: [], // the "could read better" hints drawn now
      sentences: null, // sentence boundaries from the latest check
      checkedText: null, // the text those boundaries belong to
      timer: 0, // debounce timer
      checkNumber: 0, // checks sent, to drop stale responses
      frame: 0,
    };
    badge.attach(field);
    draw(session);
    refreshEstimate();
    refreshGlossaryState();
    scheduleCheck(0); // check the existing text right away
    session.frame = requestAnimationFrame(everyFrame);
  }

  function deactivate() {
    if (!session) return;
    closePopup();
    clearTimeout(session.timer);
    cancelAnimationFrame(session.frame);
    session.adapter.destroy();
    badge.detach();
    session = null;
  }

  // ---------- Checking text, drawing squiggles ----------

  // Runs once per frame (about 60 times a second) and stays light: notice text changes, keep
  // squiggles and badge on the field.
  function everyFrame() {
    if (!session) return;
    const { adapter } = session;
    // The page removed the field (e.g. the dialog closed after sending).
    if (!adapter.isAlive()) {
      deactivate();
      return;
    }
    // Changes are found by comparing text, not only by input events: a page changing the text
    // itself (clearing it after sending) fires none.
    const text = adapter.readText();
    if (text !== session.text) onTextChanged(text);
    adapter.everyFrame();
    badge.sync();
    session.frame = requestAnimationFrame(everyFrame);
  }

  function onTextChanged(newText) {
    // The text changed; the issue on the card may have moved. Close the card.
    closePopup();
    // Until the new result arrives, move the old squiggles into place and drop the one on the word being edited.
    session.matches = shiftMatches(session.text, newText, session.matches);
    // Hint lines move the same way. The hint on the sentence being edited is dropped until the re-check.
    session.hints = shiftMatches(session.text, newText, session.hints);
    session.text = newText;
    draw(session);
    scheduleCheck(DEBOUNCE_MS);
  }

  function scheduleCheck(delay) {
    clearTimeout(session.timer);
    session.timer = setTimeout(runCheck, delay);
  }

  async function runCheck() {
    if (!session) return;
    const current = session;
    const text = current.text;

    // Text not worth checking (empty, one word in a single-line input, too long): clear squiggles, send nothing.
    if (!current.adapter.shouldCheck(text) || text.length > MAX_AUTO_CHECK_CHARS) {
      current.matches = [];
      current.hints = [];
      current.sentences = null;
      current.checkedText = null; // no result any more: the badge goes too
      draw(current);
      return;
    }

    const checkNumber = ++current.checkNumber;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "check", text });
    } catch {
      // After the extension is reloaded or updated, this script in an old page is cut off and
      // can send no more messages. Stop quietly until the user reloads the page.
      stop();
      return;
    }

    // While waiting, the user may have switched fields or triggered a newer check.
    if (session !== current || checkNumber !== current.checkNumber) return;
    // No server address, server unreachable and the like: draw nothing and do not bother the user.
    if (!response || !response.ok) return;

    let matches = notDismissed(response.data.matches);
    const sentences = response.data.sentences ?? null;
    // Free hints: guess from the issues and sentence boundaries just received which sentences
    // are worth an AI look. Computed locally; no AI call, nothing sent anywhere. Without
    // sentence boundaries (an older backend) there are no hints.
    let hints = sentences?.length
      ? findHints(text, sentenceRanges(text, sentences), matches, (sentence) => quietSentences.has(sentence))
      : [];
    // The user typed on while waiting: the result is for the old text, so shift it onto the current text.
    if (current.text !== text) {
      matches = shiftMatches(text, current.text, matches);
      hints = shiftMatches(text, current.text, hints);
    }
    // A new result invalidates the rule and hint cards. The AI card does not depend on it and
    // stays. An open badge menu stays too, so it does not close right after opening.
    if (!popup.pinned && !badge.menuOpen) closePopup();
    current.matches = matches;
    current.hints = hints;
    current.sentences = sentences;
    current.checkedText = text;
    draw(current);
  }

  // A sentence just joined the no-more-hints list: remove its hint line.
  function dropQuietHints() {
    if (!session) return;
    const kept = session.hints.filter((hint) => !quietSentences.has(hint.text));
    if (kept.length === session.hints.length) return;
    session.hints = kept;
    draw(session);
  }

  // ---------- Pointer on a line: suggestion card and hint card ----------

  let pointer = null; // latest pointer position
  let pointerFrame = 0;
  let pointerOnPopup = false;
  let waiting = null; // the target the pointer rests on; its card shows when the timer fires
  let showTimer = 0;
  let hideTimer = 0;

  // What a line stands for: the issue (red) or the hint (lavender). Used to tell whether
  // the pointer is still on the same line.
  const targetOf = (item) => item?.match ?? item?.hint ?? null;

  function onMouseMove(event) {
    // Moves over the card or the badge do not count: another line may lie right under them.
    if (popup.owns(event.target) || badge.owns(event.target)) return;
    pointer = { x: event.clientX, y: event.clientY };
    // Mouse moves come in bursts: handle them once per frame.
    if (!pointerFrame) pointerFrame = requestAnimationFrame(trackPointer);
  }

  function onMouseLeave() {
    // The pointer left this page (or frame). It may be heading for the card, so do not hide at once.
    pointer = null;
    clearTimeout(showTimer);
    showTimer = 0;
    waiting = null;
    scheduleHide();
  }

  function trackPointer() {
    pointerFrame = 0;
    if (!session || !pointer) return;
    // While an AI card is open, passing over other squiggles does not replace it: the user
    // paid for it. The same goes for an open badge menu.
    if (popup.pinned || badge.menuOpen) return;
    // The pointer is on the card (its last position may happen to lie over a line below the card).
    if (pointerOnPopup) return;
    const hit = findHit(session.adapter.markRects(), pointer.x, pointer.y);

    if (!hit) {
      clearTimeout(showTimer);
      showTimer = 0;
      waiting = null;
      scheduleHide();
      return;
    }

    clearTimeout(hideTimer);
    hideTimer = 0;
    // The card already shows this target, or the timer for it is running: nothing to do.
    const target = targetOf(hit);
    if (targetOf(popup) === target || targetOf(waiting) === target) return;

    clearTimeout(showTimer);
    waiting = hit;
    showTimer = setTimeout(
      () => {
        showTimer = 0;
        const due = waiting;
        waiting = null;
        if (due) openPopup(due);
      },
      hit.match ? POPUP_SHOW_DELAY_MS : HINT_SHOW_DELAY_MS,
    );
  }

  function openPopup(hit) {
    if (hit.match) openRuleCard(hit);
    else openHintCard(hit);
  }

  // The pointer rests on a lavender hint line: show the hint card. It is only an invitation;
  // no AI is called until the user clicks its button.
  function openHintCard(hit) {
    // The hint may be gone by the time the timer fires (text changed, or another field).
    if (!session || !session.hints.includes(hit.hint)) return;
    const { hint } = hit;
    // A hint line is often a whole row long. The card goes below the pointer, not at the
    // row's left end, or the card would hide before the pointer got there.
    const left = pointer ? Math.min(Math.max(pointer.x - 24, hit.rect.left), hit.rect.right) : hit.rect.left;
    const anchor = { left, top: hit.rect.top, bottom: hit.rect.bottom };
    popup.showHint({
      hint,
      anchor,
      estimate: estimateFor(1),
      // Only now, on the user's click, is the sentence sent to the AI.
      onImprove() {
        improveRange({ offset: hint.offset, length: hint.length }, anchor);
      },
      onDismiss() {
        closePopup();
        quietSentences.add(hint.text);
        dropQuietHints();
      },
    });
  }

  function openRuleCard(hit) {
    // The issue may be gone by the time the timer fires (text changed, or another field).
    if (!session || !session.matches.includes(hit.match)) return;
    const { match } = hit;
    popup.show({
      match,
      anchor: hit.rect,
      onApply(replacement) {
        const current = session;
        closePopup();
        // The replacement changes the text; everyFrame notices, shifts the lines and re-checks.
        if (current && current.matches.includes(match)) current.adapter.apply(match, replacement);
      },
      onDismiss() {
        closePopup();
        dismissed.add(matchKey(match));
        if (session) {
          session.matches = notDismissed(session.matches);
          draw(session);
        }
      },
      // Ask the AI to rewrite the sentence this issue is in.
      onImprove() {
        improveAround(match.offset, hit.rect);
      },
      // Add to the personal dictionary. Spelling issues only: grammar and terminology are not solved by "I know this word".
      onAddWord: match.issue_type === "misspelling" ? () => addToDictionary(match.text) : null,
    });
  }

  // The user clicked Add to dictionary on a rule card. The background script stores the
  // dictionary on this computer and filters every later check through it, on all sites.
  async function addToDictionary(word) {
    const current = session;
    closePopup();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "dictionary-add", word });
    } catch {
      return; // the extension was updated; this page needs a reload
    }
    // Not added (e.g. the dictionary is full): keep the squiggle, so the user does not think it worked.
    if (!response || !response.ok) return;
    // No need to wait for the next check: remove the spelling squiggles of this word right away.
    if (session && session === current) {
      session.matches = session.matches.filter((match) => !(match.issue_type === "misspelling" && covers(word, match.text)));
      draw(session);
      // Check again: with fewer spelling issues the hint lines and the badge count may change.
      scheduleCheck(0);
    }
  }

  function scheduleHide() {
    // An AI card is pinned and does not hide when the pointer leaves.
    if (!popup.visible || popup.pinned || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (!pointerOnPopup) closePopup();
    }, POPUP_HIDE_DELAY_MS);
  }

  function closePopup() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    waiting = null;
    pointerOnPopup = false;
    aiTicket++; // an AI answer still on its way must not reopen the card
    popup.hide();
    badge.closeMenu();
  }

  // With an AI card or the badge menu open, a click anywhere else closes it.
  function onMouseDown(event) {
    if (popup.pinned && !popup.owns(event.target)) closePopup();
    if (badge.menuOpen && !badge.owns(event.target)) badge.closeMenu();
  }

  // ---------- The corner badge and its menu ----------

  // The user clicked the badge: open the menu, or close it on a second click. Opening only
  // lists the choices; text is sent to the AI only when one is picked.
  function toggleBadgeMenu() {
    if (!session) return;
    if (badge.menuOpen) {
      badge.closeMenu();
      return;
    }
    closePopup();
    const current = session;
    // Sentence boundaries come from the last check. If the text changed since, they are stale: fall back to lines.
    const known = current.checkedText === current.text ? current.sentences : null;
    const scopes = buildScopes(current.text, sentenceRanges(current.text, known), current.adapter.selection());

    const items = [];
    const add = (name, scope) => {
      if (!scope) return;
      const count = scope.sentences > 1 ? `${scope.sentences} sentences` : "";
      items.push({
        label: SCOPE_LABELS[name],
        // The reason when over the limit; otherwise the number of sentences and the estimated cost.
        detail: scope.blocked || [count, estimateFor(scope.sentences)].filter(Boolean).join(", "),
        disabled: Boolean(scope.blocked),
        onPick: () => improveRange({ offset: scope.offset, length: scope.length }, badge.rect, name),
      });
    };
    add("sentence", scopes.sentence);
    add("selection", scopes.selection); // absent when nothing is selected
    // With a single sentence, "whole text" equals "this sentence": not listed twice.
    if (scopes.all && scopes.all.sentences > 1) add("all", scopes.all);

    const issues = current.matches.length;
    badge.openMenu({
      summary: issues === 0 ? "No issues found" : `${issues} ${issues === 1 ? "issue" : "issues"} found`,
      items,
      // Lookup: Chinese or English in, matching glossary rows from the background script out.
      lookup: {
        async search(query) {
          try {
            const response = await chrome.runtime.sendMessage({ type: "lookup", query });
            if (response && response.ok) return { rows: response.data.results };
            return { error: (response && response.error) || "The lookup failed." };
          } catch {
            return { error: "The extension was updated. Refresh this page." };
          }
        },
      },
      // The glossary switch: the same setting as on the options page.
      glossary: {
        on: glossaryOn,
        async onToggle(on) {
          glossaryOn = on;
          glossaryKnown = true;
          try {
            await chrome.runtime.sendMessage({ type: "set-glossary", on });
          } catch {
            return;
          }
          // Re-check at once with the new setting, so the squiggles follow without more typing.
          if (session) scheduleCheck(0);
        },
      },
      note: "Nothing is sent to the AI until you click.",
      onOptions() {
        chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {});
      },
    });
  }

  // ---------- AI rewriting ----------

  // Sentences the AI has already looked at on this page, with the results. Asking again for
  // the same sentence reuses the result at no cost. Until the page reloads.
  const aiResults = new Map();
  // Incremented per AI request; an answer checks it to see whether it is still the one being waited for.
  let aiTicket = 0;

  // Ask the AI to rewrite the sentence at a position. anchor is the text the card is placed next to.
  function improveAround(offset, anchor) {
    if (!session) return;
    // Sentence boundaries come from the last check. If the text changed since, they are stale: fall back to lines.
    const known = session.checkedText === session.text ? session.sentences : null;
    const range = sentenceAt(sentenceRanges(session.text, known), offset);
    if (range) improveRange(range, anchor);
  }

  // Remember the AI's answer. sent is the text that was sent.
  function rememberResult(sent, data) {
    aiResults.set(sent, data);
    for (const item of data.sentences ?? []) {
      // When several sentences were sent, each is remembered on its own as well, so a later
      // click on one of them (rule card or hint card) costs nothing.
      if (item.text !== sent) {
        aiResults.set(item.text, { ...data, sentences: [{ ...item, offset: 0, edits: relativeEdits(item) }] });
      }
      // The AI found nothing to change: stop inviting the user to ask it.
      if (item.status === "unchanged") quietSentences.add(item.text);
    }
    dropQuietHints();
  }

  // Ask the AI to rewrite a range.
  //   range   where the text is in the field
  //   anchor  where the card goes
  //   scope   what it is: sentence, selection or all
  async function improveRange(range, anchor, scope = "sentence") {
    const current = session;
    if (!current || !anchor) return;
    // The text for the AI: usually one sentence, possibly several when coming from the badge menu.
    const sentence = current.text.slice(range.offset, range.offset + range.length);
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    waiting = null;
    const ticket = ++aiTicket;

    const earlier = aiResults.get(sentence);
    if (earlier) {
      popup.showAi({ anchor, state: resultState(current, range, sentence, earlier, true) });
      return;
    }

    popup.showAi({ anchor, state: { kind: "loading", note: SENDING_NOTES[scope] } });
    let response;
    try {
      // The only place in the extension that sends text to the AI service, and only the part the user picked.
      response = await chrome.runtime.sendMessage({ type: "improve", text: sentence });
    } catch {
      stop();
      return;
    }

    // Remember the result first. The money is spent; even if the user closed the card, a later click must not pay again.
    if (response && response.ok) {
      rememberResult(sentence, response.data);
      refreshEstimate(); // money was just spent: the average changed
    }

    // While waiting, the user may have closed the card, switched fields or picked another sentence.
    if (ticket !== aiTicket || session !== current || !popup.pinned) return;

    popup.updateAi(response && response.ok ? resultState(current, range, sentence, response.data, false) : errorState(response));
  }

  // Turn the backend's response into the content of the AI card.
  function resultState(current, range, sentence, data, fromEarlier) {
    const results = data.sentences ?? [];
    if (results.length === 0) {
      return { kind: "error", message: "There is nothing to improve here.", onDismiss: closePopup };
    }

    // Several sentences may have been sent: one item per sentence in the response, one section each on the card.
    const sections = results.map((item) => ({
      segments: diffSegments(item.text, relativeEdits(item)),
      reasons: [...new Set(item.edits.map((edit) => edit.reason).filter(Boolean))],
      costLine: formatCostLine(item),
      problem: item.status === "error" ? item.error || "The AI call failed for this sentence." : "",
      hasEdits: item.edits.length > 0,
    }));

    const changed = results.filter((item) => item.edits.length > 0);
    // Sentences whose edits the user saw but did not accept mean "leave this one": their hint
    // line goes too. The result is kept, so the AI entry on a rule card shows it again for free.
    const decline = (items) => {
      for (const item of items) quietSentences.add(item.text);
      dropQuietHints();
    };

    return {
      kind: "result",
      sections,
      total: formatTotalLine(results), // empty for a single sentence
      modelLine: formatModelLine(data.model), // which model answered; once per card
      note: fromEarlier ? "Checked earlier on this page. Not charged again." : "",
      // chosen: the indexes of the ticked sections, or null (all) when the card has no checkboxes.
      onAccept:
        changed.length > 0
          ? (chosen) => {
              const accepted = chosen ? changed.filter((item) => chosen.includes(results.indexOf(item))) : changed;
              decline(changed.filter((item) => !accepted.includes(item)));
              acceptEdits(current, range, sentence, accepted);
            }
          : null,
      onDismiss() {
        closePopup();
        decline(changed);
      },
    };
  }

  function errorState(response) {
    const message = (response && response.error) || "The AI request failed.";
    // No server address or key, or the key was rejected: offer a button straight to the options page.
    const needsSetup = /is not set|was rejected/.test(message);
    return {
      kind: "error",
      message,
      onOpenOptions: needsSetup
        ? () => {
            closePopup();
            chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {});
          }
        : null,
      onDismiss: closePopup,
    };
  }

  // The user clicked Accept: apply the AI's edits to the field.
  //   sentence  the text that was sent to the AI (possibly several sentences)
  //   accepted  the sentences the user accepted (items of the response)
  function acceptEdits(current, range, sentence, accepted) {
    closePopup();
    if (session !== current) return;
    // Verify first: is that text still what was sent? If it was edited, positions are unreliable: apply nothing.
    if (current.text.slice(range.offset, range.offset + range.length) !== sentence) return;
    // The resulting sentences were written by the AI: no hint for them later.
    for (const item of accepted) quietSentences.add(applyEdits(item.text, relativeEdits(item)));
    const edits = accepted.flatMap((item) => item.edits);
    // Last edit first, so the positions of earlier edits do not shift.
    for (const edit of lastToFirst(sentence, edits)) {
      current.adapter.replace(range.offset + edit.offset, edit.length, edit.original, edit.replacement);
    }
    // The text changed; everyFrame notices, shifts the lines and re-checks.
  }

  // Pointer on the card: do not hide. The timer starts when it leaves.
  popup.onPointer = (inside) => {
    pointerOnPopup = inside;
    if (inside) {
      clearTimeout(hideTimer);
      hideTimer = 0;
      // On its way to the card the pointer may have brushed another line and started its timer. Cancel that.
      clearTimeout(showTimer);
      showTimer = 0;
      waiting = null;
    } else {
      scheduleHide();
      refreshSoon(); // if the caret is no longer in the field, the squiggles should go now too
    }
  };

  // Scrolling and key presses close the card, except inside the badge's card: scrolling the
  // lookup results or typing in the lookup box must not close it.
  function closeUnlessInBadge(event) {
    if (!badge.owns(event.target)) closePopup();
  }

  // ---------- Listeners ----------

  // Capture-phase listeners on the whole page, so no listener per field is needed.
  const listeners = [
    // Any of these can mean the caret moved somewhere else.
    [document, "focusin", refresh],
    [document, "focusout", refreshSoon],
    [document, "selectionchange", refresh], // fires on caret moves and on clicking into an editing area
    [window, "focus", refreshSoon],
    [window, "focus", onWindowFocus],
    [window, "blur", refreshSoon], // the user switched windows or clicked outside the iframe
    // suggestion card
    [document, "mousemove", onMouseMove],
    [document, "mouseleave", onMouseLeave],
    [document, "mousedown", onMouseDown],
    [document, "scroll", closeUnlessInBadge], // after scrolling the word is no longer next to the card
    [document, "keydown", closeUnlessInBadge], // typing: the card is not needed
  ];

  function stop() {
    stopped = true;
    clearTimeout(leaveTimer);
    deactivate();
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
  }

  for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);

  // The caret may already be in a field when the script starts.
  refresh();

  return {
    stop,
    // For tests only: the lines drawn now and their screen positions. kind is rule (red
    // squiggle; text is the wrong word) or hint (lavender line; text is the whole sentence).
    inspect() {
      if (!session) return [];
      return session.adapter.markRects().map(({ match, hint, rect }) => ({
        kind: match ? "rule" : "hint",
        text: match ? match.text : hint.text,
        reason: match ? "" : hint.reason,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }));
    },
  };
}
