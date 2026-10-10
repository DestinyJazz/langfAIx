// Turns the browser's own spellcheck off and returns a function that restores it.
//
// The browser also draws red squiggles under misspelled words; left on, one typo gets two
// lines. It is only off while we watch the field and is restored on leaving.

export function silenceNativeSpellcheck(element) {
  const hadAttribute = element.hasAttribute("spellcheck");
  const oldValue = element.getAttribute("spellcheck");
  element.setAttribute("spellcheck", "false");
  return () => {
    if (hadAttribute) element.setAttribute("spellcheck", oldValue);
    else element.removeAttribute("spellcheck");
  };
}
