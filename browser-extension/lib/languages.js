// The languages a user can choose. The extension's options page and the Word add-in's
// settings share this list.
//
// What is listed: the languages with 3,000 or more XML rules in LanguageTool, plus Chinese.
// Rule counts from dev.languagetool.org/languages (LanguageTool 6.6): Catalan 8,251,
// French 6,984, English 6,074, German 5,224, Dutch 3,500. Chinese has 1,863. Portuguese
// (2,919) falls just short; adding a language is one more entry here.
// Every code was sent to LanguageTool 6.8 to confirm it is accepted.
//
// code is sent to the server, which passes it on to LanguageTool unchanged.
// German is listed with a region only: plain "de" gets no spell check (the same sentence
// gave 0 issues with de and 2 with de-DE).
//
// No chrome.* in this file: the Word add-in imports it too.

export const DEFAULT_LANGUAGE = "en-US";

export const LANGUAGE_GROUPS = [
  {
    group: "English",
    items: [
      { code: "en-US", name: "English (US)" },
      { code: "en-GB", name: "English (UK)" },
      { code: "en-AU", name: "English (Australia)" },
      { code: "en-CA", name: "English (Canada)" },
    ],
  },
  {
    group: "Chinese",
    items: [{ code: "zh-CN", name: "Chinese (中文)" }],
  },
  {
    group: "Catalan",
    items: [
      { code: "ca-ES", name: "Catalan" },
      { code: "ca-ES-valencia", name: "Catalan (Valencian)" },
      { code: "ca-ES-balear", name: "Catalan (Balearic)" },
    ],
  },
  {
    group: "Dutch",
    items: [
      { code: "nl", name: "Dutch" },
      { code: "nl-BE", name: "Dutch (Belgium)" },
    ],
  },
  {
    group: "French",
    items: [
      { code: "fr", name: "French" },
      { code: "fr-CA", name: "French (Canada)" },
      { code: "fr-BE", name: "French (Belgium)" },
      { code: "fr-CH", name: "French (Switzerland)" },
    ],
  },
  {
    group: "German",
    items: [
      { code: "de-DE", name: "German (Germany)" },
      { code: "de-AT", name: "German (Austria)" },
      { code: "de-CH", name: "German (Switzerland)" },
    ],
  },
];

export function allLanguages() {
  return LANGUAGE_GROUPS.flatMap((group) => group.items);
}

// The listed name of a code; an empty string for a code that is not listed.
export function languageName(code) {
  return allLanguages().find((language) => language.code === code)?.name ?? "";
}

// Fill a <select> with the list and choose current.
// A current code that is not listed (stored by hand, or by an older version) is added and
// chosen, so that opening the settings and pressing Save does not silently change the language.
export function fillLanguageSelect(select, current) {
  const doc = select.ownerDocument;
  const option = (code, name) => {
    const element = doc.createElement("option");
    element.value = code;
    element.textContent = name;
    return element;
  };
  select.replaceChildren();
  for (const { group, items } of LANGUAGE_GROUPS) {
    const box = doc.createElement("optgroup");
    box.label = group;
    for (const { code, name } of items) box.append(option(code, name));
    select.append(box);
  }
  const wanted = String(current || DEFAULT_LANGUAGE);
  if (!languageName(wanted)) select.append(option(wanted, wanted));
  select.value = wanted;
}
