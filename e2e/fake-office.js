// A fake Office and Word, for e2e/addin.mjs.
//
// The add-in's pages only run inside Word: the Office and Word objects come from
// office.js. Tests replace office.js with this file and the page believes it is in Word.
// Only the small part the page really uses is implemented; the document is a few pages of
// text in memory.
//
// What it proves: the page has no script errors, every button's flow works, position
// conversion is right.
// What it cannot prove: whether real Word draws lines in the right place, what the popup
// looks like, whether events arrive, how fast it is. Those are tested in real Word.
//
// Tests drive the fake document through window.__fakeWord (switch pages, move the cursor,
// simulate clicks in the popup).

(() => {
  // ---------- The fake document ----------
  const state = {
    // A page is a list of paragraphs, each with an id and text.
    pages: [],
    visible: [1], // the pages on screen (1-based)
    cursor: 0, // the paragraph the cursor is in (counted across all pages)
    // Cursor or selection inside that paragraph; start equals end for a cursor. paragraphs is
    // how many paragraphs the selection touches (more than 1 across paragraphs).
    selection: { start: 0, end: 0, paragraphs: 1 },
    annotations: new Map(), // id -> { paragraph, start, length, critique, state }
    handlers: {}, // event name -> handlers
    nextId: 1,
    // Simulates Word drawing lines in the wrong place: every line starts this many characters late. Confirms the page detects it.
    shift: 0,
    calls: 0, // number of context.sync() calls
    selected: null, // the text selected in the document (the add-in selects it when jumping to an issue)
  };
  // Before the page opens a test may declare requirement sets as unsupported, to try an older Word.
  const unsupported = window.__fakeOfficeOptions?.unsupported ?? [];
  const allParagraphs = () => state.pages.flat();

  function setDocument(pages) {
    let number = 0;
    state.pages = pages.map((texts) => texts.map((text) => ({ id: `para-${++number}`, text })));
    state.annotations.clear();
  }

  // ---------- Fake Word objects ----------
  // The real API needs load and sync before values can be read. Here values are always there and both do nothing.
  const loadable = (object) => Object.assign(object, { load: () => object });

  function rangeOf(annotation) {
    const read = () => annotation.paragraph.text.slice(annotation.start, annotation.start + annotation.length);
    return loadable({
      get text() {
        return read();
      },
      insertText(text) {
        // In real Word a line disappears when its text is replaced.
        state.annotations.delete(annotation.id);
        replaceText(annotation.paragraph, annotation.start, annotation.length, text);
      },
      select() {
        state.selected = read();
      },
    });
  }

  // Replace text in a paragraph. Later lines shift and still cover the same characters, as in real Word.
  function replaceText(paragraph, start, length, text) {
    paragraph.text = paragraph.text.slice(0, start) + text + paragraph.text.slice(start + length);
    for (const other of state.annotations.values()) {
      if (other.paragraph === paragraph && other.start >= start + length) other.start += text.length - length;
    }
    fire("paragraphChanged", { uniqueLocalIds: [paragraph.id], type: "ParagraphChanged" });
  }

  function annotationProxy(annotation) {
    return loadable({
      id: annotation.id,
      get state() {
        return annotation.state;
      },
      critiqueAnnotation: { critique: annotation.critique, range: rangeOf(annotation) },
      delete() {
        state.annotations.delete(annotation.id);
        fire("removed", { ids: [annotation.id] });
      },
    });
  }

  function paragraphProxy(paragraph) {
    return loadable({
      get text() {
        return paragraph.text;
      },
      uniqueLocalId: paragraph.id,
      isListItem: false,
      tableNestingLevel: 0,
      insertAnnotations({ critiques }) {
        const ids = critiques.map((critique) => {
          if (critique.start < 0 || critique.start + critique.length > paragraph.text.length) {
            const error = new Error("The annotation is outside the paragraph.");
            error.code = "InvalidArgument";
            throw error;
          }
          const id = `annotation-${state.nextId++}`;
          state.annotations.set(id, { id, paragraph, start: critique.start + state.shift, length: critique.length, critique, state: "Created" });
          return id;
        });
        fire("inserted", { ids });
        return { value: ids };
      },
      getAnnotations() {
        const items = [...state.annotations.values()].filter((annotation) => annotation.paragraph === paragraph).map(annotationProxy);
        return loadable({ items });
      },
      select() {
        state.selected = paragraph.text;
      },
      // The paragraph start. The add-in measures the text from there to the cursor to get the cursor position.
      getRange: () => ({
        expandTo: (other) => loadable({ text: paragraph.text.slice(0, other.__offset ?? 0) }),
      }),
      // Search the paragraph: every occurrence, left to right, non-overlapping, case-sensitive (as the add-in uses it).
      search(needle) {
        const items = [];
        for (let at = paragraph.text.indexOf(needle); at !== -1; at = paragraph.text.indexOf(needle, at + needle.length)) {
          const found = { start: at, length: needle.length };
          items.push({
            text: needle,
            insertText(text) {
              replaceText(paragraph, found.start, found.length, text);
            },
          });
        }
        return loadable({ items });
      },
    });
  }

  function pageProxy(index) {
    return loadable({
      index,
      getRange: () => ({ paragraphs: loadable({ items: (state.pages[index - 1] ?? []).map(paragraphProxy) }) }),
    });
  }

  const eventSource = (name) => ({
    add(handler) {
      (state.handlers[name] ??= []).push(handler);
      return { remove() {} };
    },
  });

  function fire(name, args) {
    for (const handler of state.handlers[name] ?? []) Promise.resolve(handler(args)).catch(() => {});
  }

  const fakeDocument = {
    getSelection() {
      const all = allParagraphs();
      const first = all[state.cursor];
      const { start, end, paragraphs } = state.selection;
      const items = all.slice(state.cursor, state.cursor + paragraphs).map(paragraphProxy);
      return loadable({
        // Selecting a whole paragraph: real Word's text ends with the paragraph mark.
        text: first.text.slice(start, end) + (paragraphs > 1 ? "\r" + all[state.cursor + 1].text : ""),
        paragraphs: loadable({ items, getFirst: () => paragraphProxy(first) }),
        getRange: () => ({ __offset: start }),
        // Insert text at the cursor (replacing a selection).
        insertText(inserted) {
          replaceText(first, start, end - start, inserted);
          state.selection = { start: start + inserted.length, end: start + inserted.length, paragraphs: 1 };
        },
      });
    },
    getParagraphByUniqueLocalId(id) {
      const paragraph = allParagraphs().find((one) => one.id === id);
      if (!paragraph) {
        const error = new Error("The paragraph does not exist.");
        error.code = "ItemNotFound";
        throw error;
      }
      return paragraphProxy(paragraph);
    },
    getAnnotationById(id) {
      const annotation = state.annotations.get(id);
      if (!annotation) {
        const error = new Error("The annotation does not exist.");
        error.code = "ItemNotFound";
        throw error;
      }
      return annotationProxy(annotation);
    },
    get activeWindow() {
      return loadable({
        activePane: loadable({
          get pagesEnclosingViewport() {
            return loadable({ items: state.visible.map(pageProxy) });
          },
        }),
      });
    },
    onAnnotationClicked: eventSource("clicked"),
    onAnnotationHovered: eventSource("hovered"),
    onAnnotationInserted: eventSource("inserted"),
    onAnnotationRemoved: eventSource("removed"),
    onAnnotationPopupAction: eventSource("popupAction"),
    onParagraphChanged: eventSource("paragraphChanged"),
  };

  window.Word = {
    CritiqueColorScheme: { red: "Red", green: "Green", blue: "Blue", lavender: "Lavender", berry: "Berry" },
    InsertLocation: { replace: "Replace" },
    AnnotationState: { created: "Created", accepted: "Accepted", rejected: "Rejected" },
    async run(batch) {
      const context = {
        document: fakeDocument,
        async sync() {
          state.calls++;
        },
      };
      return batch(context);
    },
  };

  window.Office = {
    HostType: { Word: "Word" },
    context: {
      host: "Word",
      platform: "PC",
      diagnostics: { host: "Word", platform: "PC", version: "16.0.fake" },
      requirements: { isSetSupported: (name) => !unsupported.includes(name) },
    },
    onReady(callback) {
      const info = { host: "Word", platform: "PC" };
      // The real office.js also calls back only once the page is ready.
      const ready = new Promise((resolve) => {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => resolve(info));
        else resolve(info);
      });
      return callback ? ready.then(callback) : ready;
    },
  };

  // ---------- Remote control for tests ----------
  window.__fakeWord = {
    setDocument,
    setVisiblePages: (pages) => (state.visible = pages),
    moveCursorTo(index) {
      state.cursor = index;
      state.selection = { start: 0, end: 0, paragraphs: 1 };
    },
    // Put the cursor into the middle of word in paragraph index.
    putCursorIn(index, word) {
      state.cursor = index;
      const at = allParagraphs()[index].text.indexOf(word) + 1;
      state.selection = { start: at, end: at, paragraphs: 1 };
    },
    // Select text in paragraph index.
    selectText(index, text) {
      state.cursor = index;
      const start = allParagraphs()[index].text.indexOf(text);
      state.selection = { start, end: start + text.length, paragraphs: 1 };
    },
    // Select from the word `from` in paragraph index to the end of the next paragraph.
    selectAcross(index, from = "") {
      state.cursor = index;
      const text = allParagraphs()[index].text;
      state.selection = { start: from ? text.indexOf(from) : 0, end: text.length, paragraphs: 2 };
    },
    setShift: (shift) => (state.shift = shift),
    paragraphs: () => allParagraphs().map((paragraph) => paragraph.text),
    // The lines drawn now: paragraph, covered text, colour, suggestions.
    underlines: () =>
      [...state.annotations.values()].map((annotation) => ({
        id: annotation.id,
        paragraph: allParagraphs().indexOf(annotation.paragraph),
        text: annotation.paragraph.text.slice(annotation.start, annotation.start + annotation.length),
        colour: annotation.critique.colorScheme,
        suggestions: annotation.critique.popupOptions?.suggestions ?? null,
        popupTitle: annotation.critique.popupOptions?.titleResourceId ?? null,
      })),
    // Simulate a click on a suggestion in Word's popup.
    acceptSuggestion(id, suggestion) {
      const annotation = state.annotations.get(id);
      if (annotation) annotation.state = "Accepted";
      fire("popupAction", { id, action: "Accept", critiqueSuggestion: suggestion });
    },
    syncCalls: () => state.calls,

    // ----- The next ones behave as observed in real Word -----

    // A suggestion is clicked in the popup: Word removes the line, then notifies the add-in, and replaces the text itself.
    userAccepts(id, suggestion) {
      const annotation = state.annotations.get(id);
      if (!annotation) return;
      state.annotations.delete(id);
      fire("removed", { ids: [id] });
      fire("popupAction", { id, action: "Accept", critiqueSuggestion: suggestion });
      replaceText(annotation.paragraph, annotation.start, annotation.length, suggestion);
    },
    // Ignore is clicked in the popup: the line goes, the text stays.
    userIgnores(id) {
      if (!state.annotations.delete(id)) return;
      fire("removed", { ids: [id] });
      fire("popupAction", { id, action: "Reject" });
    },
    // The user changes a paragraph's text.
    userTypes(index, text) {
      const paragraph = allParagraphs()[index];
      paragraph.text = text;
      fire("paragraphChanged", { uniqueLocalIds: [paragraph.id], type: "ParagraphChanged" });
    },
    userHovers: (id) => fire("hovered", { id }),
    userClicks: (id) => fire("clicked", { id }),
    selected: () => state.selected,
  };
})();
