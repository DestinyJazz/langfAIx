// Entry point injected into pages. Its one job: load the real code (content/main.js)
// when it is needed, and start it.
//
// Why this layer: Chrome does not let scripts listed in the manifest use import, and our
// code is split into files that import each other. A dynamic import is allowed, so the
// main file is loaded that way. The loaded files must be listed under
// web_accessible_resources in manifest.json.
//
// Why only when needed: this entry is injected into every page and every frame, and most
// have no field at all (ads, for example). So only a few light listeners are attached,
// and the main code loads once the user really puts the caret into a field.

(() => {
  let started = false;

  // A rough guess whether this element could be a field. The careful check is in the main code.
  function mayBeField(element) {
    return (
      element instanceof HTMLElement &&
      (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable)
    );
  }

  function cursorInField() {
    // The page (or frame) has no focus at all: the user is not here.
    if (!document.hasFocus()) return false;
    if (mayBeField(document.activeElement)) return true;
    // Focus is not on a field, but the caret is inside an editable element.
    const anchor = document.getSelection()?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    return Boolean(element && element.isContentEditable);
  }

  // Any of these events can mean "the caret went into a field". focusin alone is not
  // enough: some editors put the editing area in a frame whose whole body is editable;
  // focus is already on the body, and the browser may send no focusin.
  const listeners = [
    [document, "focusin"],
    [document, "selectionchange"],
    [window, "focus"],
  ];

  function check() {
    // On a window focus event the browser may not have updated the focus yet: look a moment later.
    setTimeout(() => {
      if (!started && cursorInField()) boot();
    }, 0);
  }

  async function boot() {
    started = true;
    for (const [target, type] of listeners) target.removeEventListener(type, check, true);
    try {
      const { start } = await import(chrome.runtime.getURL("content/main.js"));
      start(); // on start it looks for the field the caret is in
    } catch (error) {
      // Some pages block the load. Give up quietly without affecting the page.
      console.debug("langfAIx: could not start on this page", error);
    }
  }

  for (const [target, type] of listeners) target.addEventListener(type, check, true);
  // The caret may already be in a field when the page opens.
  check();
})();
