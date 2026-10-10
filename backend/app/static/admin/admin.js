// Script of the glossary admin page.
//
// The page holds no data. After sign-in it asks the backend's /glossary/ endpoints, and
// the backend decides by role what is allowed (viewer reads, editor edits, admin manages
// people). Buttons a role cannot use are hidden here for tidiness only; the real check is
// on the server.
//
// Two ways to sign in:
//   first visit, or forgotten password: your own LiteLLM virtual key. The page then asks
//   for a sign-in name and a password
//   afterwards: name and password. The backend returns a session token, which is sent
//   with later requests; the key no longer stays in the browser
//
// All text from the database is inserted with textContent, never as HTML, so a term
// containing <script> is just displayed.

// The page is at .../admin/ and the API next to it at .../glossary/. A relative URL works
// whether the service sits under /api or runs directly on a dev machine.
const API = new URL("../glossary/", location.href);
// What stays in the browser after sign-in; only one of the two:
//   virtual key: this tab only (sessionStorage). Only for people who have not set a password
//   session token: localStorage if "Keep me signed in" is ticked (survives closing the
//   browser, until it expires), otherwise this tab only
const KEY_NAME = "langfaix-glossary-key";
const SESSION_NAME = "langfaix-glossary-session";
// Whether someone has signed in with a password on this computer; decides which sign-in form shows first.
const KNOWN_NAME = "langfaix-glossary-has-password";
// The password prompt was shown in this tab and skipped: do not ask again on reload.
const SKIPPED_NAME = "langfaix-glossary-password-skipped";
// Prefix of a session token; tells it apart from a virtual key.
const TOKEN_PREFIX = "lfs_";
const PAGE_SIZE = 100;
// Most rows shown in an import preview. More slows the browser, and nobody reads that many.
const PREVIEW_ROWS = 300;
const RANK = { viewer: 0, editor: 1, admin: 2 };
// The fields of a row, as named in the "which column is what" dropdowns on import.
const FIELDS = [
  ["zh", "Chinese"],
  ["en", "English"],
  ["category", "Category"],
  ["applies_to", "Applies to"],
  ["variants", "Wrong forms"],
  ["note", "Note"],
  ["id", "id"],
];
const STATUS_LABELS = { new: "new", update: "will change", same: "no change", skip: "left as is", error: "problem" };

const $ = (id) => document.getElementById(id);

let secret = ""; // sent in Authorization: the virtual key or the session token
let me = null; // the signed-in person: { alias, id, role, can_edit, is_admin, login, has_password, signed_in_with, password_sign_in }
let terms = [];
let categories = [];
let page = 0;
let editing = null; // the row being edited in the dialog; null when adding
let source = null; // the file or text of the latest import
let preview = null; // the latest import preview

// Create an element. Text always goes through textContent.
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function setStatus(id, message, kind = "") {
  const element = $(id);
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

// Call the backend. On failure, throws an error carrying a message for the user.
async function api(path, { method = "GET", body, raw = false } = {}) {
  // The name-and-password sign-in request carries nothing; all others carry the key or the token.
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(new URL(path, API), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Cannot reach the server. Check that you are on the company network or VPN.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).detail;
    } catch {
      // Not JSON: fall back to the status code below.
    }
    const error = new Error(typeof detail === "string" && detail ? detail : `The server returned an error (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (raw) return response;
  return response.status === 204 ? null : response.json();
}

// ---------- Browser storage ----------

// kind is "local" (survives closing the browser) or "session" (this tab only).
// Some browser settings (private mode) refuse storage and throw. That is fine: it only
// means signing in again after a reload.
function read(kind, name) {
  try {
    return window[`${kind}Storage`].getItem(name) ?? "";
  } catch {
    return "";
  }
}

// An empty value deletes.
function save(kind, name, value) {
  try {
    if (value) window[`${kind}Storage`].setItem(name, value);
    else window[`${kind}Storage`].removeItem(name);
  } catch {
  }
}

// Store the session token. keep: whether "Keep me signed in" is ticked.
function keepToken(token, keep) {
  save("session", KEY_NAME, ""); // with a token, the key need not stay
  save("local", SESSION_NAME, keep ? token : "");
  save("session", SESSION_NAME, keep ? "" : token);
  save("local", KNOWN_NAME, "1");
}

// Backend errors are lower-case fragments; capitalise them for the page.
const sentence = (message) => message.charAt(0).toUpperCase() + message.slice(1);

// ---------- Sign in and out ----------

// Which sign-in form shows: password (name and password) or key (virtual key).
function showLoginMode(mode) {
  $("password-form").hidden = mode !== "password";
  $("login-form").hidden = mode !== "key";
  setStatus("login-status", "");
  $(mode === "password" ? "login-name" : "key").focus();
}

// What the glossary is about: the source language's name, and whether it has one. The page is
// labelled "Chinese" until this arrives, which is also what an older backend would give.
async function applyProfile() {
  let profile;
  try {
    profile = await api("profile");
  } catch {
    return;
  }
  const name = profile.source_language || "Chinese";
  for (const element of document.querySelectorAll(".source-label")) element.textContent = name;
  // Found by key, not by position: this also runs again after signing out and in, when the
  // source field may already have been removed.
  const sourceField = FIELDS.find(([key]) => key === "zh");
  if (sourceField) sourceField[1] = name;
  $("search").placeholder = profile.has_source ? `Search ${name} or English` : "Search English";
  // Without a source language the column, its dialog field and its import mapping are hidden.
  document.body.classList.toggle("no-source", !profile.has_source);
  if (!profile.has_source) {
    const at = FIELDS.findIndex(([key]) => key === "zh");
    if (at !== -1) FIELDS.splice(at, 1);
  }
}

// Ask the backend "who am I" with a key or a session token. Known: enter the page. Unknown: return the error.
async function enter(candidate) {
  secret = candidate;
  try {
    me = await api("me");
  } catch (error) {
    secret = "";
    return error;
  }
  applyRole();
  await applyProfile();
  show("terms");
  return null;
}

async function signInWithKey(candidate) {
  setStatus("login-status", "Signing in...");
  const error = await enter(candidate.trim());
  if (error) {
    setStatus("login-status", sentence(error.message), "error");
    return;
  }
  save("session", KEY_NAME, secret);
  setStatus("login-status", "");
  $("key").value = "";
  // Signed in with a key: offer to set a name and password, so the key is not needed again.
  // Someone with a password who still used the key probably forgot it: offer a new one too.
  if (me.password_sign_in && !read("session", SKIPPED_NAME)) openPasswordDialog();
}

async function signInWithPassword() {
  setStatus("login-status", "Signing in...");
  let reply;
  try {
    reply = await api("login", { method: "POST", body: { login: $("login-name").value, password: $("login-password").value } });
  } catch (error) {
    setStatus("login-status", sentence(error.message), "error");
    return;
  }
  const error = await enter(reply.token);
  if (error) {
    setStatus("login-status", sentence(error.message), "error");
    return;
  }
  keepToken(reply.token, $("login-keep").checked);
  setStatus("login-status", "");
  $("login-password").value = "";
}

// A session token is still in the browser when the page opens: go straight in.
async function resume(token) {
  setStatus("login-status", "Signing in...");
  const error = await enter(token);
  if (!error) setStatus("login-status", "");
  if (!error) return;
  if (error.status === 401) {
    // The token expired or was revoked (e.g. the password was changed elsewhere).
    save("local", SESSION_NAME, "");
    save("session", SESSION_NAME, "");
  }
  setStatus("login-status", sentence(error.message), "error");
}

function signOut(message = "") {
  // Ask the server to revoke the token, without waiting: sign out here even when the server is unreachable.
  if (secret.startsWith(TOKEN_PREFIX)) api("logout", { method: "POST" }).catch(() => {});
  secret = "";
  me = null;
  terms = [];
  for (const [kind, name] of [["session", KEY_NAME], ["session", SESSION_NAME], ["local", SESSION_NAME], ["session", SKIPPED_NAME]]) save(kind, name, "");
  for (const id of ["term-dialog", "password-dialog"]) $(id).close();
  $("tabs").hidden = true;
  $("who").hidden = true;
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== "view-login";
  showLoginMode(read("local", KNOWN_NAME) ? "password" : "key");
  setStatus("login-status", message, message ? "error" : "");
}

// ---------- Set or change the password ----------

function openPasswordDialog() {
  // Signed in with a password means changing it, which needs the current password again. Not so with a key.
  const changing = me.signed_in_with === "password";
  $("pw-title").textContent = me.has_password ? "Change password" : "Create a password";
  $("pw-hint").textContent = changing
    ? "After the change you are signed out everywhere else."
    : "Next time, sign in with this name and password. You will not need the API key on this page again. If you forget the password, sign in with the API key once more and choose a new one.";
  $("pw-login").value = me.login || me.alias;
  $("pw-current-row").hidden = !changing;
  $("pw-current").required = changing;
  // Already signed in with a password: keep the token where the sign-in put it; do not ask again.
  $("pw-keep-row").hidden = changing;
  $("pw-skip").textContent = me.has_password ? "Cancel" : "Not now";
  for (const id of ["pw-current", "pw-new", "pw-repeat"]) $(id).value = "";
  setStatus("pw-status", "");
  $("password-dialog").showModal();
  $(changing ? "pw-current" : "pw-new").focus();
}

async function savePassword(event) {
  event.preventDefault(); // keep the dialog open until the backend confirms
  if ($("pw-new").value !== $("pw-repeat").value) {
    setStatus("pw-status", "The two passwords are not the same.", "error");
    return;
  }
  const changing = me.signed_in_with === "password";
  $("pw-save").disabled = true;
  let reply;
  try {
    reply = await api("password", {
      method: "POST",
      body: { login: $("pw-login").value, password: $("pw-new").value, current_password: $("pw-current").value },
    });
  } catch (error) {
    if (error.status === 401) report("terms-status", error);
    else setStatus("pw-status", sentence(error.message), "error"); // e.g. "name already taken": stay in the dialog
    return;
  } finally {
    $("pw-save").disabled = false;
  }
  // The backend returned a new session token. Use it from here on; the key leaves the browser.
  const keep = changing ? Boolean(read("local", SESSION_NAME)) : $("pw-keep").checked;
  secret = reply.token;
  keepToken(reply.token, keep);
  me = { ...me, login: reply.login, has_password: true, signed_in_with: "password" };
  applyRole();
  $("password-dialog").close();
  setStatus("terms-status", `Saved. Next time, sign in as "${reply.login}" with your password.`, "ok");
}

// Show or hide buttons and columns by role.
function applyRole() {
  for (const element of document.querySelectorAll("[data-needs]")) {
    element.hidden = RANK[me.role] < RANK[element.dataset.needs];
  }
  $("who-name").textContent = me.alias;
  $("who-name").title = me.login ? `Sign-in name: ${me.login}` : "";
  // Hidden when the server has no password sign-in (LITELLM_ADMIN_KEY not set).
  $("open-password").hidden = !me.password_sign_in;
  $("open-password").textContent = me.has_password ? "Change password" : "Set a password";
  $("who-role").textContent = me.role;
  $("who-role").className = `chip ${me.role}`;
  $("tabs").hidden = false;
  $("who").hidden = false;
  const note = $("viewer-note");
  note.hidden = me.can_edit;
  note.textContent = `You are signed in as ${me.alias} (ID ${me.id}). You can search and export. To add or change terms, ask a glossary administrator to make you an editor.`;
}

// Common error handling. An invalid key or token (401) returns to the sign-in page.
function report(statusId, error) {
  if (error.status !== 401) setStatus(statusId, error.message, "error");
  // A token can stop working for several reasons (expired, password changed elsewhere, key
  // disabled); the backend's message is the most accurate.
  else signOut(secret.startsWith(TOKEN_PREFIX) ? sentence(error.message) : "Your API key is no longer accepted. Sign in again.");
}

// ---------- Switching views ----------

function show(view) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== `view-${view}`;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("current", tab.dataset.view === view);
  // Clear messages left by the previous action, so an old "Saved ..." does not look recent.
  for (const id of ["terms-status", "history-status", "people-status"]) setStatus(id, "");
  if (view === "terms") loadTerms();
  if (view === "history") loadHistory();
  if (view === "people") loadPeople();
}

// ---------- The term table ----------

async function loadTerms() {
  try {
    const data = await api("terms");
    terms = data.terms.sort((a, b) => a.en.localeCompare(b.en) || a.id - b.id);
    categories = data.categories;
  } catch (error) {
    report("terms-status", error);
    return;
  }
  fillFilters();
  renderTerms();
}

// A dropdown: "all" first, then the given options. Keeps the current selection when possible.
function fillSelect(select, allLabel, values) {
  const chosen = select.value;
  select.replaceChildren(new Option(allLabel, ""), ...values.map((value) => new Option(value, value)));
  select.value = values.includes(chosen) ? chosen : "";
}

function fillFilters() {
  const distinct = (name) => [...new Set(terms.map((term) => term[name]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillSelect($("filter-category"), "All categories", distinct("category"));
  fillSelect($("filter-applies"), "All versions", distinct("applies_to"));
  // Category suggestions in the dialog: the defaults plus those already in use.
  $("category-options").replaceChildren(...categories.map((name) => new Option(name, name)));
}

// Rows left after the search box and the two filters. The search covers Chinese, English, wrong forms and notes.
function visibleTerms() {
  const query = $("search").value.trim().toLowerCase();
  const category = $("filter-category").value;
  const applies = $("filter-applies").value;
  return terms.filter((term) => {
    if (category && term.category !== category) return false;
    if (applies && term.applies_to !== applies) return false;
    if (!query) return true;
    return [term.zh, term.en, term.note, ...term.variants].some((value) => value.toLowerCase().includes(query));
  });
}

function renderTerms() {
  const rows = visibleTerms();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const body = $("terms-table").tBodies[0];
  body.replaceChildren();

  for (const term of rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const row = body.insertRow();
    row.dataset.id = term.id;
    row.append(el("td", "zh", term.zh), el("td", "en", term.en), el("td", "", term.category), el("td", "", term.applies_to));
    const wrong = el("td");
    for (const variant of term.variants) wrong.append(el("span", "wrong", variant));
    row.append(wrong, el("td", "note", term.note), el("td", "small", `${term.updated_by}, ${term.updated_at.slice(0, 10)}`));
    if (me.can_edit) {
      const actions = el("td", "actions");
      const edit = el("button", "edit", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => openDialog(term));
      const remove = el("button", "danger delete", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => deleteTerm(term));
      actions.append(edit, " ", remove);
      row.append(actions);
    }
  }
  if (rows.length === 0) {
    const cell = el("td", "empty", terms.length === 0 ? "The glossary is empty. Add a term, or import a spreadsheet." : "Nothing matches the search.");
    cell.colSpan = 8;
    body.insertRow().append(cell);
  }

  $("count").textContent = rows.length === terms.length ? `${terms.length} rows` : `${rows.length} of ${terms.length} rows`;
  $("page-label").textContent = `Page ${page + 1} of ${pages}`;
  $("page-prev").disabled = page === 0;
  $("page-next").disabled = page >= pages - 1;
}

// ---------- Add, change, delete ----------

function openDialog(term) {
  editing = term;
  $("term-title").textContent = term ? "Change term" : "Add term";
  $("term-zh").value = term?.zh ?? "";
  $("term-en").value = term?.en ?? "";
  $("term-category").value = term?.category ?? "";
  $("term-applies").value = term?.applies_to ?? "";
  $("term-variants").value = (term?.variants ?? []).join("\n");
  $("term-note").value = term?.note ?? "";
  setStatus("term-status", "");
  $("term-dialog").showModal();
  (term ? $("term-en") : $("term-zh")).focus();
}

async function saveTerm(event) {
  event.preventDefault(); // keep the dialog open until the backend confirms
  const body = {
    zh: $("term-zh").value,
    en: $("term-en").value,
    category: $("term-category").value,
    applies_to: $("term-applies").value,
    variants: $("term-variants").value.split("\n"),
    note: $("term-note").value,
  };
  $("term-save").disabled = true;
  try {
    if (editing) await api(`terms/${editing.id}`, { method: "PUT", body });
    else await api("terms", { method: "POST", body });
  } catch (error) {
    if (error.status === 401) {
      $("term-dialog").close();
      report("terms-status", error);
    } else {
      setStatus("term-status", error.message, "error"); // e.g. "this row already exists": stay in the dialog
    }
    return;
  } finally {
    $("term-save").disabled = false;
  }
  $("term-dialog").close();
  setStatus("terms-status", `Saved "${body.en.trim()}". It is in effect now.`, "ok");
  await loadTerms();
}

async function deleteTerm(term) {
  if (!confirm(`Delete "${term.en}"${term.zh ? ` (${term.zh})` : ""} from the glossary?`)) return;
  try {
    await api(`terms/${term.id}`, { method: "DELETE" });
  } catch (error) {
    report("terms-status", error);
    return;
  }
  setStatus("terms-status", `Deleted "${term.en}".`, "ok");
  await loadTerms();
}

// ---------- Export ----------

async function download(format) {
  let response;
  try {
    response = await api(`export?format=${format}`, { raw: true });
  } catch (error) {
    report("terms-status", error);
    return;
  }
  // The download needs the key, so a plain link will not do: fetch it, then let the browser save it.
  const link = el("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = `glossary.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------- Bulk import ----------

// Read the chosen file as base64, so it fits in the JSON sent to the backend.
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

const updateExisting = () => document.querySelector('input[name="import-mode"]:checked').value === "update";

async function startPreview() {
  const file = $("import-file").files[0];
  const text = $("import-text").value;
  // Hide the previous preview at once, so stale results are not on screen while the new file is read.
  $("import-result").hidden = true;
  if (!file && !text.trim()) {
    setStatus("import-status", "Choose a file or paste some text first.", "error");
    return;
  }
  try {
    source = file ? { filename: file.name, content_base64: await readFile(file) } : { text };
  } catch (error) {
    setStatus("import-status", error.message, "error");
    return;
  }
  await runPreview({});
}

// options may carry mapping and has_header: a re-read after the user corrected the columns.
async function runPreview(options) {
  setStatus("import-status", "Reading...");
  $("import-result").hidden = true;
  try {
    preview = await api("import/preview", { method: "POST", body: { ...source, ...options, update_existing: updateExisting() } });
  } catch (error) {
    report("import-status", error);
    return;
  }
  setStatus("import-status", preview.needs_mapping ? "Could not tell which column is the English term. Choose the columns below and read again." : "", preview.needs_mapping ? "error" : "");
  renderPreview();
}

function renderPreview() {
  $("import-result").hidden = false;

  const counts = $("import-counts");
  counts.replaceChildren();
  for (const status of ["new", "update", "same", "skip", "error"]) {
    if (preview.counts[status]) counts.append(el("span", `chip ${status}`, `${preview.counts[status]} ${STATUS_LABELS[status]}`));
  }

  // The "which column is what" dropdowns.
  $("import-header").checked = preview.has_header;
  const mapping = $("import-mapping");
  mapping.replaceChildren();
  for (const [name, label] of FIELDS) {
    const box = el("div");
    const select = el("select");
    select.dataset.field = name;
    select.append(new Option("(not in this file)", ""), ...preview.columns.map((column, index) => new Option(column, String(index))));
    select.value = name in preview.mapping ? String(preview.mapping[name]) : "";
    box.append(el("label", "", label), select);
    mapping.append(box);
  }
  $("import-columns").open = preview.needs_mapping;

  const body = $("import-table").tBodies[0];
  body.replaceChildren();
  for (const item of preview.rows.slice(0, PREVIEW_ROWS)) {
    const row = body.insertRow();
    row.className = item.status;
    const result = el("td");
    result.append(el("span", `chip ${item.status}`, STATUS_LABELS[item.status]));
    for (const message of item.messages) result.append(el("div", "messages", message));
    const data = item.data;
    const wrong = el("td");
    for (const variant of data.variants) wrong.append(el("span", "wrong", variant));
    row.append(el("td", "small", item.line), result, el("td", "zh", data.zh), el("td", "en", data.en), el("td", "", data.category), el("td", "", data.applies_to), wrong, el("td", "note", data.note));
  }
  const truncated = $("import-truncated");
  truncated.hidden = preview.rows.length <= PREVIEW_ROWS;
  truncated.textContent = `Showing the first ${PREVIEW_ROWS} of ${preview.rows.length} rows. All of them are counted above and will be imported.`;

  const usable = preview.counts.new + preview.counts.update;
  const confirmButton = $("import-confirm");
  confirmButton.disabled = usable === 0;
  confirmButton.textContent = usable === 0 ? "Nothing to import" : `Import ${usable} rows`;
}

async function rereadPreview() {
  const mapping = {};
  for (const select of $("import-mapping").querySelectorAll("select")) {
    if (select.value !== "") mapping[select.dataset.field] = Number(select.value);
  }
  await runPreview({ mapping, has_header: $("import-header").checked });
}

async function confirmImport() {
  // Send back only new and changed rows. The backend validates every row again.
  const rows = preview.rows
    .filter((item) => item.status === "new" || item.status === "update")
    .map((item) => ({ ...item.data, line: item.line, ...(item.id ? { id: item.id } : {}) }));
  $("import-confirm").disabled = true;
  let result;
  try {
    result = await api("import", { method: "POST", body: { rows, update_existing: updateExisting() } });
  } catch (error) {
    report("import-status", error);
    $("import-confirm").disabled = false;
    return;
  }
  const done = `Imported: ${result.counts.new} new, ${result.counts.update} changed. They are in effect now.`;
  const trouble = result.problems.length ? ` ${result.problems.length} rows were not imported.` : "";
  setStatus("import-status", done + trouble, result.problems.length ? "error" : "ok");
  $("import-result").hidden = true;
  $("import-file").value = "";
  $("import-text").value = "";
  preview = null;
  source = null;
}

// ---------- Change log ----------

async function loadHistory() {
  let data;
  try {
    data = await api("changes");
  } catch (error) {
    report("history-status", error);
    return;
  }
  const body = $("history-table").tBodies[0];
  body.replaceChildren();
  for (const change of data.changes) {
    // Stored in UTC, shown in this computer's time zone.
    body.insertRow().append(el("td", "small", new Date(change.at).toLocaleString()), el("td", "", change.by), el("td", "", change.summary));
  }
  if (data.changes.length === 0) {
    const cell = el("td", "empty", "No changes yet.");
    cell.colSpan = 3;
    body.insertRow().append(cell);
  }
}

// ---------- People and roles ----------

async function loadPeople() {
  let data;
  try {
    data = await api("people");
  } catch (error) {
    report("people-status", error);
    return;
  }
  const body = $("people-table").tBodies[0];
  body.replaceChildren();
  for (const person of data.people) {
    const select = el("select");
    select.append(...Object.keys(RANK).map((role) => new Option(role, role)));
    select.value = person.role;
    // Admins named in the server settings cannot be changed here.
    select.disabled = person.fixed;
    select.addEventListener("change", () => setRole(person, select.value));
    const role = el("td");
    role.append(select);
    if (person.fixed) role.append(el("div", "muted", "set on the server"));
    const row = body.insertRow();
    row.dataset.alias = person.alias;
    row.append(el("td", "en", person.alias), el("td", "", person.login), el("td", "small", person.id), role, el("td", "small", new Date(person.last_seen).toLocaleString()));
  }
}

async function setRole(person, role) {
  try {
    await api(`people/${person.key_hash}`, { method: "PUT", body: { role } });
  } catch (error) {
    report("people-status", error);
    await loadPeople(); // reset the dropdown to the actual role
    return;
  }
  setStatus("people-status", `${person.alias} is now ${role}.`, "ok");
}

// ---------- Wiring up the buttons ----------

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  signInWithKey($("key").value);
});
$("password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  signInWithPassword();
});
$("use-key").addEventListener("click", () => showLoginMode("key"));
$("use-password").addEventListener("click", () => showLoginMode("password"));
$("sign-out").addEventListener("click", () => signOut());
$("open-password").addEventListener("click", openPasswordDialog);
$("pw-form").addEventListener("submit", savePassword);
$("pw-skip").addEventListener("click", () => $("password-dialog").close());
// The dialog closed without saving (Not now, or Esc): do not open it automatically again
// in this tab. The button at the top right still opens it.
$("password-dialog").addEventListener("close", () => {
  if (me?.signed_in_with === "key") save("session", SKIPPED_NAME, "1");
});
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => show(tab.dataset.view));

for (const id of ["search", "filter-category", "filter-applies"]) {
  $(id).addEventListener("input", () => {
    page = 0;
    renderTerms();
  });
}
$("page-prev").addEventListener("click", () => {
  page -= 1;
  renderTerms();
});
$("page-next").addEventListener("click", () => {
  page += 1;
  renderTerms();
});
$("add-term").addEventListener("click", () => openDialog(null));
$("term-form").addEventListener("submit", saveTerm);
$("term-cancel").addEventListener("click", () => $("term-dialog").close());
$("export-xlsx").addEventListener("click", () => download("xlsx"));
$("export-csv").addEventListener("click", () => download("csv"));
$("import-preview").addEventListener("click", startPreview);
$("import-reread").addEventListener("click", rereadPreview);
$("import-confirm").addEventListener("click", confirmImport);

// On page load: go straight in if a session token or a key is still in the browser.
showLoginMode(read("local", KNOWN_NAME) ? "password" : "key");
const rememberedToken = read("session", SESSION_NAME) || read("local", SESSION_NAME);
const rememberedKey = read("session", KEY_NAME);
if (rememberedToken) resume(rememberedToken);
else if (rememberedKey) signInWithKey(rememberedKey);
