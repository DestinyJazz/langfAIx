// Tests for deciding whether a single-line input should be checked.

import assert from "node:assert/strict";
import { test } from "node:test";

import { inputSkipReason, looksLikeProse } from "../lib/sensitive.js";

const allowed = (field) => assert.equal(inputSkipReason(field), "", `should be checked: ${JSON.stringify(field)}`);
const skipped = (field) => assert.notEqual(inputSkipReason(field), "", `should be skipped: ${JSON.stringify(field)}`);

test("a plain text input is checked", () => {
  allowed({ type: "text" });
  allowed({ type: "" }); // an input without a type is a text input
  allowed({});
});

test("inputs meant for a sentence are checked", () => {
  allowed({ type: "text", name: "subject" });
  allowed({ type: "text", name: "title", placeholder: "Ticket title" });
  allowed({ type: "text", id: "summary", ariaLabel: "Short description" });
  allowed({ type: "text", name: "comment" });
  allowed({ type: "text", placeholder: "What needs to be done?" });
});

test("password and other non-text types are never checked", () => {
  for (const type of ["password", "email", "number", "tel", "url", "search", "date", "hidden", "PASSWORD"]) {
    skipped({ type });
  }
});

test("autocomplete hints for personal data are respected", () => {
  for (const autocomplete of [
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "username",
    "email",
    "tel",
    "given-name",
    "family-name",
    "street-address",
    "postal-code",
    "bday",
    "shipping address-line1",
  ]) {
    skipped({ type: "text", autocomplete });
  }
});

test("autocomplete off or on does not block checking", () => {
  allowed({ type: "text", autocomplete: "off" });
  allowed({ type: "text", autocomplete: "on" });
});

test("a password field shown as plain text is still skipped", () => {
  // A "show password" button often just changes the type from password to text.
  skipped({ type: "text", name: "password" });
  skipped({ type: "text", id: "login_pwd" });
  skipped({ type: "text", autocomplete: "current-password" });
});

test("names are recognised in different spellings", () => {
  skipped({ type: "text", name: "name" });
  skipped({ type: "text", placeholder: "Your name" });
  skipped({ type: "text", name: "firstName" });
  skipped({ type: "text", name: "first_name" });
  skipped({ type: "text", id: "billing-last-name" });
  skipped({ type: "text", name: "user[email]" });
  skipped({ type: "text", placeholder: "Card number" });
  skipped({ type: "text", ariaLabel: "Phone" });
  skipped({ type: "text", name: "otp" });
  skipped({ type: "text", name: "zipCode" });
  skipped({ type: "text", id: "cityInput" });
});

test("two words written together are still recognised", () => {
  // Found on a real site: the customer-name input of httpbin.org is called custname.
  skipped({ type: "text", name: "custname" });
  skipped({ type: "text", name: "useremail" });
  skipped({ type: "text", id: "homephone" });
  skipped({ type: "text", name: "zipcode" });
  skipped({ type: "text", name: "cardnumber" });
  skipped({ type: "text", id: "billingaddress" });
  skipped({ type: "text", name: "hostname" });
});

test("the label next to the box is taken into account", () => {
  skipped({ type: "text", name: "f1", label: "Customer name: " });
  skipped({ type: "text", name: "f2", label: "Phone" });
  allowed({ type: "text", name: "f3", label: "Subject" });
  allowed({ type: "text", name: "f4", label: "What happened?" });
});

test("the ending rule does not catch ordinary words", () => {
  // tournament contains "name" but does not end with it.
  allowed({ type: "text", name: "tournament_notes" });
  allowed({ type: "text", name: "summary" });
  allowed({ type: "text", id: "feedback" });
  allowed({ type: "text", name: "comment" });
});

test("search boxes are skipped", () => {
  skipped({ type: "text", name: "q", role: "searchbox" });
  skipped({ type: "text", placeholder: "Search..." });
  skipped({ type: "text", role: "combobox" });
  skipped({ type: "text", ariaLabel: "Filter results" });
  skipped({ type: "text", list: "suggestions" });
});

test("a word that merely contains a sensitive word is not blocked", () => {
  // "pin" must not match "opinion", "tel" not "hotel", "ip" not "description".
  allowed({ type: "text", name: "opinion" });
  allowed({ type: "text", name: "hotel_notes" });
  allowed({ type: "text", name: "description" });
  allowed({ type: "text", placeholder: "Tell us what happened" });
  allowed({ type: "text", name: "statement" });
});

test("numeric or email keyboards mean it is not a sentence", () => {
  skipped({ type: "text", inputMode: "numeric" });
  skipped({ type: "text", inputMode: "email" });
  allowed({ type: "text", inputMode: "text" });
});

test("looksLikeProse needs at least two words", () => {
  assert.equal(looksLikeProse("Printer does not work"), true);
  assert.equal(looksLikeProse("two words"), true);
  assert.equal(looksLikeProse("  spaced   out  "), true);
  assert.equal(looksLikeProse("single"), false);
  assert.equal(looksLikeProse("  single  "), false);
  assert.equal(looksLikeProse(""), false);
  assert.equal(looksLikeProse("INC0012345"), false);
});
