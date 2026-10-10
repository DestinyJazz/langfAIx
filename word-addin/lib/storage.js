// Where the Word add-in keeps its settings and personal dictionary.
//
// In the localStorage of the task pane's page: this computer only, no account. Tried in
// real Word: values survive closing and reopening the task pane.
//
// The browser extension uses chrome.storage.local, a different place. The read/write
// interface here mirrors it (get takes names, set takes values), so the extension's files
// that take storage as a parameter (lib/settings.js, lib/dictionary-store.js) work here
// unchanged.

const PREFIX = "langfaix:";

// area is localStorage, passed in so tests can use a fake.
export function localStore(area) {
  return {
    async get(keys) {
      const found = {};
      for (const key of keys) {
        const raw = area.getItem(PREFIX + key);
        if (raw === null) continue;
        try {
          found[key] = JSON.parse(raw);
        } catch {
          // Unreadable content (written by another version): treated as never saved.
        }
      }
      return found;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) area.setItem(PREFIX + key, JSON.stringify(value));
    },
  };
}
