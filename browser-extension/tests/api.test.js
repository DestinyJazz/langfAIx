// Tests for the code that talks to the backend. A fake fetch; no network.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createApi } from "../lib/api.js";

const SETTINGS = { apiUrl: "https://example.com/api", apiKey: "sk-user", language: "en-GB" };

// A fake fetch that records each call and returns the given response.
function fakeFetch(respond) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  return { fetchFn, calls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeApi(respond, settings = SETTINGS) {
  const { fetchFn, calls } = fakeFetch(respond);
  return { api: createApi({ fetchFn, getSettings: async () => settings }), calls };
}

test("health calls /healthz", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { status: "ok" }));

  assert.deepEqual(await api.health(), { ok: true, data: { status: "ok" } });
  assert.equal(calls[0].url, "https://example.com/api/healthz");
  assert.equal(calls[0].options.method, "GET");
});

test("check posts the text and uses the language from settings", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { language: "en-GB", matches: [] }));

  const result = await api.check("Hello wrold.");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://example.com/api/check");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: "Hello wrold.", language: "en-GB", glossary: true });
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
});

test("check does not send the API key", async () => {
  // A rule check needs no key, so the key must not be sent.
  const { api, calls } = makeApi(() => jsonResponse(200, { language: "en-GB", matches: [] }));
  await api.check("Hello.");
  assert.equal("Authorization" in calls[0].options.headers, false);
});

test("an explicit language overrides the setting", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { language: "en-US", matches: [] }));
  await api.check("Hello.", "en-US");
  assert.equal(JSON.parse(calls[0].options.body).language, "en-US");
});

test("no request is made when the server address is missing", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, {}), { ...SETTINGS, apiUrl: "" });

  const result = await api.check("Hello.");

  assert.equal(result.ok, false);
  assert.match(result.error, /server address is not set/);
  assert.equal(calls.length, 0);
});

test("a network failure becomes a readable message", async () => {
  const { api } = makeApi(() => {
    throw new TypeError("Failed to fetch");
  });
  const result = await api.health();
  assert.equal(result.ok, false);
  assert.match(result.error, /Cannot reach the server/);
});

test("a timeout becomes a readable message", async () => {
  const { api } = makeApi(() => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  });
  assert.match((await api.health()).error, /did not answer in time/);
});

test("the server's own explanation is passed on", async () => {
  const { api } = makeApi(() => jsonResponse(400, { detail: "Error: 'xx' is not a language code known to LanguageTool." }));
  const result = await api.check("Hello.", "xx");

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /not a language code/);
});

test("404 hints that the address is probably wrong", async () => {
  const { api } = makeApi(() => jsonResponse(404, { detail: "Not Found" }));
  assert.match((await api.health()).error, /address looks wrong/);
});

test("a successful answer that is not JSON is treated as a wrong address", async () => {
  // E.g. the address lacks /api and reaches an ordinary web page.
  const { api } = makeApi(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  }));
  const result = await api.health();
  assert.equal(result.ok, false);
  assert.match(result.error, /not in the expected format/);
});

// ---------- AI rewriting ----------

test("improve posts the text with the API key", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { model: "m", sentences: [] }));

  const result = await api.improve("This are a test.");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://example.com/api/ai/improve");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: "This are a test.", language: "en-GB", glossary: true });
  // Only this request carries the key, unchanged, in Authorization.
  assert.equal(calls[0].options.headers["Authorization"], "Bearer sk-user");
});

test("improve makes no request when the API key is missing", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, {}), { ...SETTINGS, apiKey: "" });

  const result = await api.improve("This are a test.");

  assert.equal(result.ok, false);
  assert.match(result.error, /API key is not set/);
  // Without a key no request is sent: the text does not leave this computer.
  assert.equal(calls.length, 0);
});

test("a rejected key gives a short message instead of the server's technical details", async () => {
  // A real server response for an invalid key: long and technical, useless to a user.
  const detail =
    "Authentication Error, Invalid proxy server token passed. Received API Key = sk-...ting, Key Hash (Token) =81b5... " +
    "Unable to find token in cache or `LiteLLM_VerificationTokenTable`";
  const { api } = makeApi(() => jsonResponse(401, { detail }));

  const result = await api.improve("Hello there.");

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /API key was rejected/);
  assert.doesNotMatch(result.error, /Hash|LiteLLM/);
});

test("a key that the server says is missing gives the same message as an empty setting", async () => {
  const { api } = makeApi(() => jsonResponse(401, { detail: "missing API key: send your LiteLLM virtual key in the Authorization header as Bearer sk-..." }));
  assert.match((await api.improve("Hello there.")).error, /API key is not set/);
});

test("the reason is passed on when the budget is used up", async () => {
  const { api } = makeApi(() => jsonResponse(400, { detail: "Budget has been exceeded! Current cost: 1.02, Max budget: 1.0" }));
  assert.match((await api.improve("Hello there.")).error, /Budget has been exceeded/);
});

test("check still does not send the key after improve was added", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { language: "en-GB", matches: [] }));
  await api.check("Hello.");
  await api.health();
  for (const call of calls) assert.equal("Authorization" in call.options.headers, false);
});

// ---------- The team glossary switch ----------

test("the glossary switch is passed on to the server for checking and for AI improve", async () => {
  // Glossary turned off in the settings: both kinds of request must tell the server.
  const off = { ...SETTINGS, useGlossary: false };
  const { api, calls } = makeApi(() => jsonResponse(200, { matches: [], sentences: [] }), off);

  await api.check("Hello.");
  await api.improve("Hello.");

  assert.equal(JSON.parse(calls[0].options.body).glossary, false);
  assert.equal(JSON.parse(calls[1].options.body).glossary, false);
});

test("the glossary is used unless it was switched off", async () => {
  // Settings saved by an older version have no such switch: treated as on.
  const { api, calls } = makeApi(() => jsonResponse(200, { matches: [] }));
  await api.check("Hello.");
  assert.equal(JSON.parse(calls[0].options.body).glossary, true);
});

// ---------- Lookup ----------

test("lookup asks the server with the API key, whatever language was typed", async () => {
  const rows = { results: [{ id: 1, zh: "归档中心", en: "Archiving Center" }] };
  const { api, calls } = makeApi(() => jsonResponse(200, rows));

  // Chinese and English input use the same request; the server searches both directions.
  assert.deepEqual(await api.lookup("归档中心"), { ok: true, data: rows });
  await api.lookup("archive center & more");

  assert.equal(calls[0].url, `https://example.com/api/glossary/lookup?q=${encodeURIComponent("归档中心")}`);
  // Spaces, & and other characters special in URLs must be encoded, or the server receives a truncated word.
  assert.equal(calls[1].url, "https://example.com/api/glossary/lookup?q=archive%20center%20%26%20more");
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "Bearer sk-user");
  }
});

test("lookup makes no request when the API key is missing", async () => {
  const { api, calls } = makeApi(() => jsonResponse(200, { results: [] }), { ...SETTINGS, apiKey: "" });
  const result = await api.lookup("policy");
  assert.equal(result.ok, false);
  assert.match(result.error, /API key is not set/);
  assert.equal(calls.length, 0);
});

test("lookup passes on the server's explanation when something is wrong", async () => {
  const rejected = makeApi(() => jsonResponse(401, { detail: "the API key was rejected: it may be mistyped, expired or disabled" }));
  assert.match((await rejected.api.lookup("policy")).error, /API key was rejected/);

  const unavailable = makeApi(() => jsonResponse(503, { detail: "the glossary database is not available right now, try again in a moment" }));
  assert.match((await unavailable.api.lookup("policy")).error, /not available right now/);
});
