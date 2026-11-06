// The state of the page, the helpers every view uses, and the messages at the top.
import { model } from './start.js';

export const core = globalThis.tinyprobeCore;
export const runView = globalThis.tinyprobeRunView;
export const envFile = globalThis.tinyprobeEnvironmentFile;
export const requestHistory = globalThis.tinyprobeHistory;
export const flows = globalThis.tinyprobeFlow;
export const editing = globalThis.tinyprobeEditor;

/** As in the extension: the last 50 calls, bodies cut at 64 KiB. */
export const HISTORY_SIZE = 50;

export const state = {
  info: null,
  root: null,
  listing: null,
  model: null,
  environment: null,
  selection: { kind: 'home' },
  outcomes: new Map(),
  variables: [],
  history: [],
  // The events of the last run of each workflow, to light its diagram up again; the diagram on screen.
  runs: new Map(),
  // The result panel of the last run of each workflow, where a click on the diagram shows a step.
  runViews: new Map(),
  flow: null
};

// --- Helpers ---------------------------------------------------------------------------------------------

/** An element with attributes and children; strings become text nodes, so nothing is parsed as HTML. */
export function h(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name in node && typeof value !== 'string') node[name] = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = id => document.getElementById(id);

/** The children worth adding: replaceChildren would write a null as the text "null". */
export const nodes = (...children) => children.flat().filter(child => child !== null && child !== undefined && child !== false);

/** A field of a form: an input in the monospace font (names, paths, values), a select or a textarea. */
export const control = (tag, attributes, ...children) => h(tag, { class: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'input mono', autocomplete: 'off', spellcheck: 'false', ...attributes }, ...children);

/** A row of a form for one named value: its label (* when required), its input, and a free last cell. */
export function valueRow(prefix, name, { required = false, ...input } = {}) {
  return h('div', { class: 'row', 'data-name': name },
    h('label', { class: 'mono', for: `${prefix}-${name}` }, name, required ? h('span', { class: 'required' }, '*') : null),
    control('input', { id: `${prefix}-${name}`, ...input }),
    h('span'));
}

/** The values of the rows made by valueRow, in their order: [{ name, value }]. */
export const rowValues = area => [...area.querySelectorAll('[data-name]')].map(row => ({ name: row.dataset.name, value: row.querySelector('input').value }));

export function remember(key, value) {
  try {
    localStorage.setItem(`tinyprobe:${key}`, JSON.stringify(value));
  } catch {
    // A private window: the page works, it only forgets.
  }
}

export function recall(key, fallback) {
  try {
    const value = localStorage.getItem(`tinyprobe:${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const slash = path => String(path ?? '').replace(/\\/g, '/');
export const baseName = path => slash(path).split('/').filter(Boolean).pop() ?? path;

export class RestartError extends Error {}

export async function api(path, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  if (response.status === 401) {
    showRestart();
    throw new RestartError('restart');
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(json?.error ?? `The app answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return json;
}

export async function text(path) {
  const response = await fetch(path);
  if (response.status === 401) {
    showRestart();
    throw new RestartError('restart');
  }
  if (!response.ok) return null;
  return response.text();
}

export const query = parameters => new URLSearchParams(parameters).toString();

// --- Messages --------------------------------------------------------------------------------------------

export function showMessage(message, kind) {
  const results = $('results');
  const node = h('div', { class: `notice${kind === 'info' ? ' info' : ''}`, role: 'status' }, message);
  results.prepend(node);
  setTimeout(() => node.remove(), kind === 'info' ? 4000 : 8000);
}

export function showRestart() {
  if (document.querySelector('.overlay')) return;
  document.body.append(h('div', { class: 'overlay', role: 'alertdialog', 'aria-labelledby': 'restart-title' },
    h('div', { class: 'card' },
      h('h2', { id: 'restart-title' }, 'Open tinyprobe again'),
      h('p', null, 'The app was stopped or restarted, so this page cannot reach it. Start tinyprobe from its icon: it opens a new page.'))));
}

export function showFatal(message) {
  $('view').replaceChildren(h('div', { class: 'welcome' }, h('h1', null, 'The app does not answer'), h('p', { class: 'lead' }, message)));
}
