// Start: the launcher's state, the folder's files read through tinyprobe inspect, the environment.
import { $, api, baseName, core, h, query, recall, remember, RestartError, showFatal, showMessage, showRestart, slash, state, text } from './base.js';
import { checkUpdates, renderVersions } from './dialogs.js';
import { holdsInput, render, renderChrome, renderSidebar } from './render.js';
import { stream } from './runs.js';

// --- Start ---------------------------------------------------------------------------------------------

export async function boot() {
  try {
    state.info = await api('/api/state');
  } catch (e) {
    if (!(e instanceof RestartError)) showFatal(e.message);
    return;
  }
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('folder');
  if (location.hash) history.replaceState(null, '', '/');
  const known = state.info.folders.filter(f => f.exists).map(f => f.path);
  const wanted = [fromLink, recall('root', null), known[0]].find(path => path && known.includes(path));
  renderChrome();
  renderVersions();
  checkUpdates();
  if (state.info.tinyprobe && wanted) await openRoot(wanted);
  else render();
}

export async function openRoot(root) {
  state.root = root;
  state.environment = recall(`env:${root}`, null);
  state.selection = { kind: 'home' };
  // The last run of each workflow, as recordOutcome keeps it; one of a file no longer there is dropped below.
  state.outcomes = new Map(Object.entries(recall(`outcomes:${root}`, {})).filter(([, o]) => o && typeof o === 'object'));
  remember('root', root);
  $('results').replaceChildren();
  state.history = await api(`/api/history?${query({ root })}`).catch(() => []);
  await loadListing();
}

/**
 * Reads the folder and draws it. With `{ quiet: true }` (the page came back to the front) a form keeps what was typed
 * in it: only the top bar and the sidebar are drawn again.
 */
export async function loadListing({ quiet = false } = {}) {
  if (!state.root || !state.info?.tinyprobe) return;
  // The first time a folder is opened its view is a progress screen; later readings only show the thin bar.
  const first = !state.model || state.listing?.root !== state.root;
  progress({ done: 0, total: null, first });
  try {
    state.listing = await readFolder(step => progress({ ...step, first }));
  } catch (e) {
    progress(null);
    if (e instanceof RestartError) return;
    state.listing = null;
    state.model = null;
    state.root = null;
    remember('root', null);
    render();
    showMessage(`The folder could not be read: ${e.message}`);
    return;
  }
  progress(null);
  state.model = model(state.listing);
  if (state.environment && !state.listing.environments.includes(state.environment)) state.environment = null;
  // One environment file: nothing to choose.
  if (!state.environment && state.listing.environments.length === 1 && recall(`env:${state.root}`, undefined) === undefined) state.environment = state.listing.environments[0];
  await loadVariables();
  if (quiet && holdsInput()) {
    renderChrome();
    renderSidebar();
  } else {
    render();
  }
}

/** Reads the folder through the launcher's stream: `{"total"}`, a `{"done"}` per file, then `{"listing"}`. */
export async function readFolder(onProgress) {
  const response = await fetch(`/api/folder?${query({ root: state.root, stream: '1' })}`);
  if (response.status === 401) {
    showRestart();
    throw new RestartError('restart');
  }
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    throw new Error(json?.error ?? `The app answered ${response.status}.`);
  }
  let total = null;
  let listing = null;
  const lines = new core.LineSplitter(line => {
    const event = JSON.parse(line);
    if (event.total !== undefined) total = event.total;
    if (event.listing) listing = event.listing;
    else onProgress({ done: event.done ?? 0, total });
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true }));
  }
  lines.push(decoder.decode());
  lines.end();
  if (!listing) throw new Error('The folder could not be read to the end.');
  return listing;
}

/** The bar under the top bar while a folder is read, and on the first reading a view that says how far it is. */
export function progress(step) {
  state.loading = step;
  const bar = $('progress');
  bar.hidden = !step;
  if (!step) return;
  const known = step.total !== null && step.total !== undefined && step.total > 0;
  bar.classList.toggle('indeterminate', !known);
  bar.firstElementChild.style.width = known ? `${Math.round((step.done / step.total) * 100)}%` : '';
  bar.setAttribute('aria-valuenow', known ? String(step.done) : '');
  bar.setAttribute('aria-valuemax', known ? String(step.total) : '');
  if (step.first) {
    $('view').replaceChildren(h('div', { class: 'welcome loading' },
      h('h1', null, `Opening ${baseName(state.root)}`),
      h('p', { class: 'lead' }, known
        ? `Reading the tinyprobe files with tinyprobe: ${step.done} of ${step.total}.`
        : 'Looking for the tinyprobe files of the folder…'),
      h('div', { class: 'progress-large' }, h('div', { class: 'progress-fill', style: null })),
      h('p', { class: 'aside' }, 'Each file is checked by tinyprobe, imports included: a large folder takes a few seconds the first time. After that, only the files that changed, and those that import them, are read again.')));
    const large = $('view').querySelector('.progress-large');
    large.classList.toggle('indeterminate', !known);
    large.firstElementChild.style.width = known ? `${Math.round((step.done / step.total) * 100)}%` : '';
  }
}

export async function loadVariables() {
  state.variables = [];
  if (!state.environment) return;
  const content = await text(`/api/file?${query({ root: state.root, path: state.environment })}`).catch(() => null);
  if (content !== null) state.variables = core.topLevelKeys(content);
}

/** The folder as people look at it: API files with their endpoints, workflows, sequences, and invalid files. */
export function model(listing) {
  const apis = [];
  const workflows = [];
  const sequences = [];
  const invalid = [];
  for (const file of listing.files) {
    const inspect = file.inspect;
    if (!inspect) {
      invalid.push({ path: file.path, errors: [{ text: `${file.path}: tinyprobe could not read this file` }] });
      continue;
    }
    if (!inspect.valid) {
      invalid.push({ path: file.path, errors: inspect.errors ?? [] });
      continue;
    }
    // Endpoints are listed where they are written; a workflow lists those of its imports too.
    const own = (inspect.endpoints ?? []).filter(e => slash(e.location?.file) === file.path || slash(e.location?.file).endsWith(`/${file.path}`));
    if (inspect.kind === 'api') apis.push({ path: file.path, endpoints: own, inspect });
    else if (inspect.kind === 'workflow') {
      workflows.push({ path: file.path, name: inspect.name || baseName(file.path), inspect });
      if (own.length > 0) apis.push({ path: file.path, endpoints: own, inspect, workflow: true });
    } else if (inspect.kind === 'sequence') sequences.push({ path: file.path, name: inspect.name || baseName(file.path), inspect });
  }
  return { apis, workflows, sequences, invalid };
}
