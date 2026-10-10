// Talks to the langfAIx backend.
//
// These functions only run in the background service worker. A request from a page
// script is subject to that page's CORS rules, while the extension's background script
// has host_permissions and can reach the server directly.
//
// Every function returns { ok: true, ... } or { ok: false, error: "message for the user" }
// and never throws, so callers only look at ok.

const TIMEOUT_MS = 20000;
// An AI rewrite waits for the model and is much slower than a rule check.
const AI_TIMEOUT_MS = 90000;

// fetchFn and getSettings are parameters so tests can pass fakes.
export function createApi({ fetchFn, getSettings }) {
  async function request(path, { method = "GET", body, needsKey = false, timeout = TIMEOUT_MS } = {}) {
    const settings = await getSettings();
    if (!settings.apiUrl) {
      return { ok: false, error: "The server address is not set. Open the extension options to set it." };
    }
    if (needsKey && !settings.apiKey) {
      return { ok: false, error: "The API key is not set. Open the extension options to set it." };
    }

    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // The key is only sent with requests that need it.
    if (needsKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

    let response;
    try {
      response = await fetchFn(settings.apiUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      return { ok: false, error: describeNetworkError(error) };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON: handled by status code below.
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: describeHttpError(response.status, data) };
    }
    if (data === null) {
      // A success status but no JSON: most likely a wrong address that reached some other page.
      return { ok: false, error: "The server answered, but not in the expected format. Check the server address." };
    }
    return { ok: true, data };
  }

  return {
    health: () => request("/healthz"),

    // Rule check. language defaults to the one in the settings.
    // glossary tells the server whether to use the team glossary, as set by the user's switch.
    async check(text, language) {
      const settings = await getSettings();
      return request("/check", {
        method: "POST",
        body: { text, language: language || settings.language, glossary: settings.useGlossary !== false },
      });
    },

    // Lookup: Chinese or English in, matching glossary rows out. The glossary is private to
    // the team, so the key is sent.
    async lookup(query) {
      return request(`/glossary/lookup?q=${encodeURIComponent(query)}`, { needsKey: true });
    },

    // AI rewrite. The only request that costs money and the only one that sends text to an AI
    // service, so only it carries the user's virtual key, and only after the user clicked.
    async improve(text, language) {
      const settings = await getSettings();
      return request("/ai/improve", {
        method: "POST",
        body: { text, language: language || settings.language, glossary: settings.useGlossary !== false },
        needsKey: true,
        timeout: AI_TIMEOUT_MS,
      });
    },
  };
}

export function describeNetworkError(error) {
  if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The server did not answer in time.";
  }
  return "Cannot reach the server. Check the address, and that you are on the company network or VPN.";
}

export function describeHttpError(status, data) {
  // Backend errors come as { "detail": "..." }.
  const detail = data && typeof data.detail === "string" ? data.detail : "";
  // 401 is a key problem. The server's text is long and technical (a LiteLLM error dump),
  // so it is replaced by one sentence that says what to do.
  if (status === 401) {
    return /missing API key/i.test(detail)
      ? "The API key is not set. Open the extension options to set it."
      : "The API key was rejected. Check the key in the extension options: it may be mistyped or disabled.";
  }
  if (status === 429) return detail || "Too many requests right now. Try again in a moment.";
  if (status === 404) return "The server address looks wrong (404 Not Found). It usually ends with /api";
  if (status === 413) return detail || "The text is too long.";
  if (status === 502) return "The grammar service behind the server is not available right now.";
  return detail ? `${detail} (HTTP ${status})` : `The server returned an error (HTTP ${status}).`;
}
