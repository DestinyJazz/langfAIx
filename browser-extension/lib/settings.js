// Loading and saving settings.
//
// Kept in chrome.storage.local: this computer only, not synced with the browser account.
// The virtual key is a secret, which is why the syncing chrome.storage.sync is not used.

const DEFAULTS = {
  // Backend address, e.g. https://your-server.example.com/api
  apiUrl: "",
  // LiteLLM virtual key. Only AI rewriting needs it; rule checks do not.
  apiKey: "",
  language: "en-US",
  // Use the team glossary. Off: checks and AI rewrites behave as if there were none. Lookup is unaffected.
  useGlossary: true,
};

// Normalise the address: trim, and drop a trailing slash, so apiUrl + "/check" is safe.
export function normalizeApiUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

// Validate the address. Empty string means fine, otherwise the message for the user.
export function validateApiUrl(value) {
  const url = normalizeApiUrl(value);
  if (!url) return "Enter the server address.";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "This is not a valid address. It should look like https://your-server.example.com/api";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The address must start with https://";
  }
  return "";
}

// storage is chrome.storage.local, passed in so tests can use a fake.
export async function loadSettings(storage) {
  const stored = await storage.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  // Off only when false was stored explicitly. Anything else (odd value, never saved) means on.
  settings.useGlossary = settings.useGlossary !== false;
  return settings;
}

// Switch the team glossary on or off. Saved on its own, without touching address or key:
// the switch should take effect at once, with no Save.
export async function setUseGlossary(storage, on) {
  await storage.set({ useGlossary: Boolean(on) });
}

// Address of the glossary admin page: the server address plus /admin/. Empty while no server address is set.
export function glossaryPageUrl(apiUrl) {
  const url = normalizeApiUrl(apiUrl);
  return url ? `${url}/admin/` : "";
}

export async function saveSettings(storage, values) {
  const clean = {
    apiUrl: normalizeApiUrl(values.apiUrl),
    apiKey: String(values.apiKey ?? "").trim(),
    language: String(values.language ?? DEFAULTS.language).trim() || DEFAULTS.language,
  };
  await storage.set(clean);
  return clean;
}
