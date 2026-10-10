// Decides whether a single-line input should be checked.
//
// Single-line inputs differ from multi-line ones: most hold not sentences but passwords,
// emails, card numbers, names, addresses, search terms. Checking those is bad twice over:
//   1. privacy: the content would be sent to the server
//   2. useless: names of people and places would be flagged as misspellings
// So the principle is "when in doubt, do not check". Only inputs that look like they are
// for writing a sentence pass: an email subject, a ticket title, a short description.
//
// This function never touches the DOM. It looks at a few properties the caller collected,
// so it is testable outside a browser.

// Only these types can hold a sentence (a missing type means text). password, email,
// number, tel, url, date, search and so on are never checked.
const ALLOWED_TYPES = new Set(["", "text"]);

// autocomplete tells the browser what to fill in. Any of these means personal data or a
// secret, not a sentence.
const SENSITIVE_AUTOCOMPLETE = [
  "password", // current-password、new-password
  "one-time-code",
  "cc-", // the credit-card fields
  "username",
  "email",
  "tel",
  "name", // name, given-name, family-name and so on
  "address", // street-address, address-line1 and so on
  "postal-code",
  "country",
  "bday",
  "organization",
  "url",
];

// These words in the field's name, id, placeholder or labels also mean: do not check.
// \b is a word boundary, so "pin" does not match "opinion".
const SENSITIVE_WORDS = new RegExp(
  [
    // secrets
    "pass(word|wd|code|phrase)?",
    "pwd",
    "otp",
    "pin",
    "token",
    "secret",
    "api[-_ ]?key",
    "captcha",
    "2fa",
    "mfa",
    "verification",
    // money
    "card",
    "cvv",
    "cvc",
    "ccnum",
    "iban",
    "swift",
    "account",
    "acct",
    "coupon",
    "promo",
    // identity
    "user(name)?",
    "login",
    "e[-_ ]?mail",
    "phone",
    "mobile",
    "tel",
    "ssn",
    "passport",
    "(first|last|full|given|family|sur|middle|nick)[-_ ]?name",
    "name",
    "birth(day|date)?",
    "dob",
    // addresses
    "address",
    "addr",
    "street",
    "city",
    "state",
    "province",
    "zip",
    "postal",
    "postcode",
    "country",
    // not sentences
    "search",
    "query",
    "find",
    "filter",
    "url",
    "website",
    "domain",
    "hostname",
    "ip",
  ]
    .map((word) => `\\b${word}\\b`)
    .join("|"),
  "i",
);

// Developers often run two words together in a field name: custname, useremail, zipcode,
// cardnumber. There is no word boundary inside, so the rule above misses them. For name
// and id, a word ending in one of these is therefore skipped too. Ending, not containing,
// to limit false hits: tournament contains "name" but does not end with it.
const SENSITIVE_SUFFIXES = ["name", "mail", "phone", "password", "passwd", "pwd", "address", "addr", "code", "card", "number"];

// Split "firstName", "first_name", "first-name" into separate words for the rules above.
function words(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]:/]+/g, " ");
}

function sensitiveSuffix(value) {
  for (const word of words(value).toLowerCase().split(/\s+/)) {
    const suffix = SENSITIVE_SUFFIXES.find((ending) => word.length > ending.length && word.endsWith(ending));
    if (suffix) return word;
  }
  return "";
}

// field is a plain object:
//   { type, autocomplete, name, id, placeholder, ariaLabel, label, role, inputMode, list }
// label is the label text next to the input on the page, e.g. "Customer name:".
// Returns an empty string if the field may be checked, otherwise the reason (for debugging and tests).
export function inputSkipReason(field) {
  const type = String(field.type ?? "").toLowerCase();
  if (!ALLOWED_TYPES.has(type)) return `type is ${type}`;

  const autocomplete = String(field.autocomplete ?? "").toLowerCase();
  for (const hint of SENSITIVE_AUTOCOMPLETE) {
    if (autocomplete.includes(hint)) return `autocomplete is ${autocomplete}`;
  }

  // Search boxes and inputs with a dropdown hold keywords, not sentences.
  const role = String(field.role ?? "").toLowerCase();
  if (role === "searchbox" || role === "combobox" || role === "spinbutton") return `role is ${role}`;
  if (field.list) return "has a list of options";

  // A numeric or email keyboard is never for sentences.
  const inputMode = String(field.inputMode ?? "").toLowerCase();
  if (inputMode && inputMode !== "text") return `inputmode is ${inputMode}`;

  // Text for people (placeholder, labels) and names for code: all checked with the whole-word rule.
  for (const key of ["name", "id", "placeholder", "ariaLabel", "label"]) {
    const found = words(field[key]).match(SENSITIVE_WORDS);
    if (found) return `${key} mentions "${found[0].toLowerCase()}"`;
  }

  // Names for code are checked with the run-together ending rule as well.
  for (const key of ["name", "id"]) {
    const found = sensitiveSuffix(field[key]);
    if (found) return `${key} "${found}" ends like a personal-data field`;
  }

  return "";
}

// Text in a single-line input must look like a sentence: at least two words. One word is
// usually a name, a number or a keyword, and checking it only yields "misspelling".
export function looksLikeProse(text) {
  return /\S\s+\S/.test(String(text ?? "").trim());
}
