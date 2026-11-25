// Global variables for single calls (tinyprobe spec 0023).
//
// An endpoint declares in its API file which values of a 2xx response it saves (`globals: { token: $.access_token }`);
// tinyprobe call --globals reads and writes them in globals.local.json of the opened folder, and any endpoint that
// writes ${token} uses the value saved. This module shows them: what each endpoint saves, what it uses and whether
// that value is there, the list of the values with who saved them and when, and saving a value of a response.
import { api, baseName, control, core, editing, h, query, RestartError, showMessage, state } from './base.js';
import { renderSidebar, renderView, select } from './render.js';
import { loadListing } from './start.js';

/** Reads globals.local.json of the folder: { name: { value, from, at } }. */
export async function loadGlobals() {
  state.globals = {};
  if (!state.root || !state.info?.globals) return;
  try {
    const file = await api(`/api/globals?${query({ root: state.root })}`);
    for (const [name, item] of Object.entries(file ?? {})) {
      state.globals[name] = item && typeof item === 'object' && !Array.isArray(item) && 'value' in item
        ? { value: item.value, from: item.from ?? null, at: item.at ?? null }
        : { value: item, from: null, at: null };
    }
  } catch (e) {
    if (!(e instanceof RestartError)) showMessage(e.message);
  }
}

/** Which endpoint saves each global: name → { file, endpoint, path }, the first one written. */
export function savers() {
  const found = new Map();
  for (const file of state.model?.apis ?? []) {
    for (const endpoint of file.endpoints) {
      for (const [name, path] of Object.entries(endpoint.globals ?? {})) {
        if (!found.has(name)) found.set(name, { file: file.path, endpoint, path });
      }
    }
  }
  return found;
}

/** A value as people read it: text without quotes, a long one cut so a token does not fill the screen. */
export function shortValue(value, max = 28) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "just now" in the first minute, "10:12" today, "23 Nov 10:12" otherwise. */
export function when(at) {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  if (Date.now() - date.getTime() < 60_000) return 'just now';
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

async function writeGlobals(body) {
  const file = await api('/api/globals', { root: state.root, ...body });
  state.globals = {};
  for (const [name, item] of Object.entries(file ?? {})) state.globals[name] = { value: item.value, from: item.from ?? null, at: item.at ?? null };
  renderSidebar();
  renderView();
}

export const setGlobal = (name, value, from = null) => {
  justSaved.set(name, Date.now());
  return writeGlobals({ action: 'set', name, value, from });
};

// When each global was saved by this page, for the flash of its line: a view drawn again during the flash goes on
// with it where it was (a negative animation delay) instead of starting it over.
const justSaved = new Map();
const FLASH_MS = 2400;

function flash(name) {
  const since = Date.now() - (justSaved.get(name) ?? 0);
  if (since >= FLASH_MS) {
    justSaved.delete(name);
    return null;
  }
  return `animation-delay: -${since}ms`;
}
export const deleteGlobal = name => writeGlobals({ action: 'delete', name });
export const clearGlobals = () => writeGlobals({ action: 'clear' });

/**
 * After a call: the globals saved (and those missing) go into a notice, and the list is read again.
 * `events` are the call's ndjson events.
 */
export async function afterCall(endpointName, events) {
  const done = events.find(e => e.event === 'step_completed');
  if (!done) return;
  const saved = Object.keys(done.globals ?? {});
  if (saved.length > 0) showMessage(`Saved ${saved.length === 1 ? 'the global variable' : 'the global variables'} ${saved.join(', ')} (from ${endpointName}).`, 'info');
  for (const missing of done.globals_missing ?? []) showMessage(`Global variable not saved: ${missing}.`);
  for (const name of saved) justSaved.set(name, Date.now());
  if (saved.length > 0) await loadGlobals();
  renderSidebar();
  renderView();
}

// --- On an endpoint ----------------------------------------------------------------------------------------

/**
 * The globals of an endpoint, above its form, one per line in two lists: Saves (what this endpoint saves from its
 * response, with the value saved now) and Uses (the ${…} it uses that are globals: where it writes them, who saved
 * the value and when, or that it is not saved yet, with a button to call the endpoint that saves it). An endpoint
 * that uses none gets how to use one, and for a token a button that sends it as a Bearer token.
 * `uses` are the endpoint's arguments that are global variables; `call(file, endpoint)` sends an endpoint.
 */
export function endpointGlobals(file, endpoint, uses, call) {
  if (!state.info.globals) return null;
  const saves = Object.entries(endpoint.globals ?? {});
  const known = savers();
  const used = uses.filter(n => n in state.globals || known.has(n));
  // Global variables this endpoint could use: there now or saved by an endpoint, not its own.
  const available = [...new Set([...Object.keys(state.globals), ...known.keys()])].filter(n => !(endpoint.globals ?? {})[n]);
  if (saves.length === 0 && used.length === 0 && available.length === 0) return null;

  const full = value => typeof value === 'string' ? value : JSON.stringify(value);
  // A line: a green check when the variable has a value, an empty grey circle (and grey text) when it has none
  // yet; a line just saved flashes green once.
  const line = (name, text, right) => {
    const set = name in state.globals;
    const delay = set ? flash(name) : null;
    return h('div', { class: `global-line ${set ? 'set' : 'unset'}${delay ? ' just-saved' : ''}`, style: delay },
      h('span', { class: 'global-status', 'aria-label': set ? 'saved' : 'not saved yet', style: delay }, set ? '✓' : ''),
      h('span', { class: 'mono global-name' }, `${name}:`), h('span', { class: 'global-text' }, text), h('span', { class: 'spacer' }), right);
  };

  const saved = saves.map(([name, path]) => {
    const current = state.globals[name];
    return line(name, ['from ', h('strong', { class: 'mono' }, path), ' of the response'], current
      ? h('span', { class: 'aside', title: full(current.value) }, `${shortValue(current.value)} · ${when(current.at)}`)
      : h('span', { class: 'aside' }, 'not saved yet: send it'));
  });
  const usedLines = used.map(name => {
    const current = state.globals[name];
    const saver = known.get(name);
    // Where the endpoint writes ${name}: filled in once the file as written is read (the auth set it comes from).
    const where = h('span', { class: 'global-where' }, whereUsed(endpoint, name, null));
    fillWhere(where, file, endpoint, name);
    if (current) {
      const by = current.from === 'by hand' || !current.from ? 'set by hand' : `saved from ${current.from} endpoint`;
      return line(name, [where, ` · ${by} · ${when(current.at)}`], h('span', { class: 'aside', title: full(current.value) }, shortValue(current.value)));
    }
    return line(name, [where, ` · not saved yet: the ${saver?.endpoint.name ?? '?'} endpoint saves it`],
      saver ? h('button', { type: 'button', class: 'button small', onclick: () => call(saver.file, saver.endpoint) }, `▶ Call ${saver.endpoint.name}`) : null);
  });

  // Uses none: how an endpoint uses a global variable, and one click for a token.
  const howTo = [];
  if (used.length === 0 && available.length > 0) {
    const tokens = available.filter(n => /token|jwt|bearer/i.test(n));
    const status = h('div', { 'aria-live': 'polite' });
    howTo.push(h('div', { class: 'global-none' },
      h('div', { class: 'global-line unset' },
        h('span', { class: 'global-status', 'aria-label': 'none' }),
        h('span', { class: 'global-text' }, 'none yet'), h('span', { class: 'spacer' }),
        tokens.map(name => h('button', { type: 'button', class: 'button small primary', onclick: async event => {
          event.target.disabled = true;
          try {
            await useAsBearer(file, endpoint.name, name, status);
          } finally {
            event.target.disabled = false;
          }
        } }, `Use ${name} as Bearer token`))),
      h('div', { class: 'hint' }, 'An endpoint uses a global variable by writing ', h('span', { class: 'placeholder' }, `\${${available[0]}}`),
        ' in its path, headers, body or auth set: in Edit, pick an auth set that sends it, or add a header such as ',
        h('span', { class: 'mono' }, 'Authorization: Bearer '), h('span', { class: 'placeholder' }, `\${${tokens[0] ?? available[0]}}`), '.'),
      status));
  }

  return h('section', { class: 'globals-box', 'aria-label': 'Global variables' },
    h('div', { class: 'globals-title' }, h('span', null, 'Global variables'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'link-button', onclick: () => select({ kind: 'globals' }) }, 'All of them →')),
    saved.length > 0 ? h('div', { class: 'globals-section' }, h('div', { class: 'globals-section-title' }, 'Saves'), saved) : null,
    usedLines.length > 0 || howTo.length > 0
      ? h('div', { class: 'globals-section' }, h('div', { class: 'globals-section-title' }, 'Uses'), usedLines, howTo) : null);
}

/**
 * Where an endpoint writes ${name}, from what `inspect` says of it: "in the Authorization header", "in the path"...
 * `written` is the endpoint and the file as written (`inspect --source`), to name the auth set a header comes from.
 */
function whereUsed(endpoint, name, written) {
  const mark = `\${${name}}`;
  const has = value => value !== null && value !== undefined && (typeof value === 'string' ? value : JSON.stringify(value)).includes(mark);
  const places = [];
  if (has(endpoint.base_url)) places.push('the base URL');
  if (has(endpoint.path)) places.push('the path');
  for (const header of endpoint.headers ?? []) {
    if (!has(header.value)) continue;
    const own = written?.endpoint?.headers && has(Object.entries(written.endpoint.headers).find(([n]) => n.toLowerCase() === header.name.toLowerCase())?.[1]);
    const sets = [written?.endpoint?.auth ?? []].flat().filter(set => has(written?.auth?.[set]));
    places.push(`the ${header.name} header${!own && sets.length > 0 ? ` (auth set ${sets.join(', ')})` : ''}`);
  }
  if (has(endpoint.body)) places.push('the body');
  if (has(endpoint.form) || has(endpoint.multipart)) places.push('the form');
  if (has(endpoint.basic_auth)) places.push('Basic auth');
  if (has(endpoint.oauth2)) places.push('OAuth2');
  return places.length > 0 ? `in ${places.join(', ')}` : `as \${${name}}`;
}

// The API files as written (inspect --source), read once per reading of the folder: the auth sets of endpoints.
const sources = new Map();

/** A file as written (`inspect --source`), read again only after the folder is. */
export function writtenFile(file) {
  const key = `${state.root}:${file}`;
  let cached = sources.get(key);
  if (!cached || cached.listing !== state.listing) {
    const source = api(`/api/source?${query({ root: state.root, path: file })}`);
    source.catch(() => sources.delete(key));
    cached = { listing: state.listing, source };
    sources.set(key, cached);
  }
  return cached.source;
}

/** What an auth set sends, as written: `Authorization: Bearer ${token}`, Basic auth, an OAuth2 token. */
export function describeAuthSet(set) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) return '';
  return Object.entries(set).map(([key, value]) =>
    key === 'basic' ? `Authorization: Basic, with ${value?.username ?? '?'} and ${value?.password ?? '?'}`
      : key === 'oauth2' ? `Authorization: Bearer, a token from ${value?.token_url ?? 'the token URL'} for ${value?.client_id ?? '?'}`
        : `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ');
}

/** Where the value of ${name} comes from: a global variable, the environment, or the call. */
export function whereFrom(name) {
  const current = state.info.globals ? state.globals[name] : undefined;
  const saver = state.info.globals ? savers().get(name) : undefined;
  if (current) return `${name}: global variable, ${current.from && current.from !== 'by hand' ? `saved by ${current.from}` : 'set by hand'}`;
  if (saver) return `${name}: global variable, not saved yet (${saver.endpoint.name} saves it)`;
  if (state.variables.includes(name)) return `${name}: from ${baseName(state.environment)}`;
  return `${name}: a value to fill in when you send it`;
}

async function fillWhere(node, file, endpoint, name) {
  try {
    const source = await writtenFile(file);
    const written = source.inspect?.source;
    const local = endpoint.import_name ? endpoint.name.slice(endpoint.import_name.length + 1) : endpoint.name;
    node.textContent = whereUsed(endpoint, name, { endpoint: written?.endpoints?.[local], auth: written?.auth });
  } catch {
    // Without the file as written the line keeps where the variable is, without the auth set.
  }
}

/**
 * "Use token as Bearer token": the endpoint picks the auth set that sends `Authorization: Bearer ${token}` when the
 * file has one and the endpoint has no auth set yet; otherwise it gets that header itself.
 */
async function useAsBearer(file, endpointName, name, status) {
  const wanted = `Bearer \${${name}}`;
  let how = null;
  const done = await rewriteEndpoint(file, endpointName, status, (form, source) => {
    const sets = source.inspect?.source?.auth ?? {};
    const set = Object.keys(sets).find(n => {
      const headers = sets[n];
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
      const keys = Object.keys(headers);
      return keys.length === 1 && keys[0].toLowerCase() === 'authorization' && headers[keys[0]] === wanted;
    });
    if (set && !form.auth) {
      form.auth = set;
      how = `the auth set ${set}`;
      return null;
    }
    if (form.headers.some(header => header.name.toLowerCase() === 'authorization')) {
      return `${endpointName} already sends an Authorization header: change it with Edit.`;
    }
    form.headers = [...form.headers, { name: 'Authorization', value: wanted }];
    how = 'an Authorization header';
    return null;
  });
  if (done) showMessage(`${endpointName} now sends ${name} as a Bearer token, with ${how}.`, 'info');
}

/** Adds `name: path` to the `globals` of an endpoint. */
function addToEndpoint(file, endpointName, name, path, status) {
  return rewriteEndpoint(file, endpointName, status, form => {
    form.globals = (form.globals ?? []).filter(g => g.name !== name).concat([{ name, path }]);
    return null;
  });
}

/**
 * Changes one endpoint through the form's YAML writer and /api/save (tinyprobe checks the file): `change(form,
 * source)` edits the form of the endpoint, or returns why it cannot. Returns whether the file was saved.
 */
async function rewriteEndpoint(file, endpointName, status, change) {
  try {
    const source = await api(`/api/source?${query({ root: state.root, path: file })}`);
    const block = (source.inspect?.blocks ?? []).find(b => b.kind === 'endpoint' && b.name === endpointName);
    const written = source.inspect?.source?.endpoints?.[endpointName];
    if (!block || !written) throw new Error(`${endpointName} is not written in ${file}.`);
    const form = editing.requestFromSource(endpointName, written);
    if (form.unsupported) throw new Error(`${endpointName} has ${form.unsupported.join(', ')}: change it as YAML.`);
    if (String(form.auth).includes(',')) throw new Error(`${endpointName} has several auth sets: change it as YAML.`);
    const problem = change(form, source);
    if (problem) throw new Error(problem);
    const request = { ...form, query: form.query.split(','), defaults: form.defaults };
    const next = editing.replaceBlock(source.text, block, core.endpointYaml(request, editing.indentOf(block)));
    const answer = await api('/api/save', { root: state.root, path: file, text: next, basis: source.text });
    if (!answer.saved) {
      status.replaceChildren(h('div', { class: 'notice' }, 'tinyprobe does not accept the file with this change: ',
        (answer.inspect?.errors ?? []).map(e => e.text).join('; ')));
      return false;
    }
    status.replaceChildren();
    await loadListing({ quiet: true });
    return true;
  } catch (e) {
    if (!(e instanceof RestartError)) status.replaceChildren(h('div', { class: 'notice' }, e.message));
    return false;
  }
}

/** The JSON values of a response body, scalars and short lists, as JSONPaths: [{ path, value }]. */
export function valuesOf(body, prefix = '$', depth = 0, out = []) {
  if (out.length >= 60 || depth > 4) return out;
  if (Array.isArray(body)) {
    body.slice(0, 3).forEach((item, i) => {
      if (item && typeof item === 'object') valuesOf(item, `${prefix}[${i}]`, depth + 1, out);
      else out.push({ path: `${prefix}[${i}]`, value: item });
    });
  } else if (body && typeof body === 'object') {
    for (const [key, item] of Object.entries(body)) {
      const path = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${prefix}.${key}` : `${prefix}['${key.replace(/'/g, "\\'")}']`;
      if (item && typeof item === 'object') valuesOf(item, path, depth + 1, out);
      else out.push({ path, value: item });
    }
  }
  return out;
}

/** A name for a value: the last key of its path, made a valid variable name (access_token → token stays as is). */
function suggestedName(path) {
  const last = path.replace(/\[\d+\]$/, '').split(/[.[\]']/).filter(Boolean).pop() ?? 'value';
  return last === 'access_token' ? 'token' : last.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Under the response of a call: "Save a value as a global variable". Picks a value of the JSON body, a name, and
 * writes `globals: { name: path }` into the endpoint of the API file (tinyprobe checks the file), then saves the
 * value at once, so the endpoints that use it work without sending this one again.
 */
export function saveFromResponse(file, endpoint, bodyText) {
  if (!state.info.globals) return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const values = valuesOf(body);
  if (values.length === 0) return null;

  const status = h('div', { 'aria-live': 'polite' });
  const pick = control('select', { 'aria-label': 'Value of the response' },
    values.map(({ path, value }) => h('option', { value: path }, `${path}  =  ${shortValue(value, 36)}`)));
  const name = control('input', { 'aria-label': 'Name of the global variable', placeholder: 'token', value: suggestedName(values[0].path) });
  pick.addEventListener('change', () => { name.value = suggestedName(pick.value); });
  const save = h('button', { type: 'submit', class: 'button small primary' }, 'Save');
  const form = h('form', { class: 'keep-form', hidden: true, onsubmit: async event => {
    event.preventDefault();
    const variable = name.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      status.replaceChildren(h('div', { class: 'notice' }, 'A name of letters, digits and _, e.g. token.'));
      return;
    }
    save.disabled = true;
    try {
      const chosen = values.find(v => v.path === pick.value);
      if (await addToEndpoint(file, endpoint.name, variable, pick.value, status)) {
        await setGlobal(variable, chosen.value, endpoint.name);
        showMessage(`${endpoint.name} saves ${variable} from ${pick.value} after each call; saved now: ${shortValue(chosen.value)}.`, 'info');
        form.hidden = true;
      }
    } finally {
      save.disabled = false;
    }
  } },
    h('span', { class: 'aside' }, 'Save'), pick, h('span', { class: 'aside' }, 'as'), name, save,
    h('button', { type: 'button', class: 'button small', onclick: () => { form.hidden = true; } }, 'Cancel'),
    status);
  return h('div', { class: 'keep-bar' },
    h('button', { type: 'button', class: 'button small primary', onclick: () => { form.hidden = !form.hidden; } }, 'Save a value as a global variable'),
    form);
}

// --- The list ----------------------------------------------------------------------------------------------

export function globalsView() {
  const names = Object.keys(state.globals);
  const known = savers();
  const shown = new Set();
  const rows = names.map(name => {
    const item = state.globals[name];
    const full = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
    const valueCell = h('code', { class: 'global-value', title: 'Click to show it all' }, shortValue(item.value, 40));
    valueCell.addEventListener('click', () => {
      const open = shown.has(name);
      open ? shown.delete(name) : shown.add(name);
      valueCell.textContent = open ? shortValue(item.value, 40) : full;
    });
    const users = (state.model?.apis ?? []).flatMap(a => a.endpoints.filter(e => (e.arguments ?? []).includes(name)).map(e => e.name));
    return h('tr', null,
      h('td', { class: 'mono' }, name),
      h('td', null, valueCell),
      h('td', { class: 'aside' }, item.from && item.from !== 'by hand' ? `${item.from} endpoint` : 'set by hand'),
      h('td', { class: 'aside' }, when(item.at)),
      h('td', { class: 'aside' }, users.length > 0 ? users.join(', ') : '—'),
      h('td', null,
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'button small', onclick: () => editValue(name, full) }, 'Edit'),
          h('button', { type: 'button', class: 'button small', onclick: () => deleteGlobal(name) }, 'Delete'))));
  });

  // Kept by an endpoint, not there yet.
  const waiting = [...known].filter(([name]) => !(name in state.globals));

  return h('div', null,
    h('div', { class: 'title-row' }, h('h1', null, 'Global variables'),
      h('span', { class: 'spacer' }),
      names.length > 0 ? h('div', { class: 'title-actions' }, h('button', { type: 'button', class: 'button small', onclick: () => clearGlobals() }, 'Delete all')) : null),
    h('p', { class: 'lead' }, 'Values saved by single calls for the next ones, in globals.local.json of this folder (keep it out of Git: it holds tokens). An endpoint saves them with globals: in its API file; any endpoint that writes ${name} uses them. Workflows ignore them unless their run says so.'),
    names.length > 0
      ? h('table', { class: 'globals-table' },
        h('thead', null, h('tr', null, ['Name', 'Value', 'Saved from', 'When', 'Used by', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows))
      : h('p', { class: 'aside' }, 'None yet. Send an endpoint that saves one, or add one by hand.'),
    waiting.length > 0 ? h('div', { class: 'notice info' },
      'Saved by an endpoint, not there yet: ',
      waiting.map(([name, k], i) => [i > 0 ? ', ' : '', h('button', { type: 'button', class: 'link-button', onclick: () => select({ kind: 'endpoint', file: k.file, name: k.endpoint.name }) }, `${name} (${k.endpoint.name})`)])) : null,
    addByHand());
}

/** Edit: the value goes into the form below, to change and save with Set. */
function editValue(name, current) {
  const form = document.getElementById('global-by-hand');
  if (!form) return;
  form.elements.name.value = name;
  form.elements.value.value = current;
  form.elements.value.focus();
  form.elements.value.select();
}

/** A value typed in: JSON when it reads as JSON (42, true, "42"), text otherwise. */
function typedValue(text) {
  try {
    const value = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}

function addByHand() {
  const name = control('input', { name: 'name', placeholder: 'token', 'aria-label': 'Name' });
  const value = control('input', { name: 'value', placeholder: 'value', 'aria-label': 'Value' });
  return h('form', { id: 'global-by-hand', class: 'keep-form', onsubmit: event => {
    event.preventDefault();
    const variable = name.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return showMessage('A name of letters, digits and _, e.g. token.');
    setGlobal(variable, typedValue(value.value));
  } }, h('span', { class: 'aside' }, 'Set by hand'), name, value, h('button', { type: 'submit', class: 'button small' }, 'Set'));
}
