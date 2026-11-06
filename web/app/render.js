// Rendering: the top bar, the sidebar and the view of the selection.
import { $, api, baseName, h, recall, remember, RestartError, showMessage, state } from './base.js';
import { authView, endpointEditView, yamlView } from './views/editor.js';
import { endpointView } from './views/endpoint.js';
import { environmentView } from './views/environment.js';
import { historyView } from './views/history.js';
import { homeView, installView, welcomeView } from './views/home.js';
import { newRequestView } from './views/request.js';
import { newWorkflowView, stepEditView } from './views/steps.js';
import { sequenceView, workflowView } from './views/workflow.js';

// --- Rendering -------------------------------------------------------------------------------------------

/**
 * The views where people type what is not saved yet: a refresh of the folder must not draw them again, or what was
 * typed is lost. Their save checks that the file did not change meanwhile.
 */
const FORMS = new Set(['new', 'new-workflow', 'edit-endpoint', 'edit-step', 'yaml', 'auth', 'environment']);

export function holdsInput() {
  return FORMS.has(state.selection.kind) || Boolean(document.querySelector('#view form.duplicate:not([hidden])'));
}

export function render() {
  renderChrome();
  renderSidebar();
  renderView();
}

export function renderChrome() {
  const ready = Boolean(state.info?.tinyprobe && state.root && state.listing);
  const folderButton = $('folder-button');
  folderButton.hidden = !state.info?.tinyprobe || !state.root;
  folderButton.replaceChildren(h('span', null, '📁'), h('span', null, baseName(state.root ?? '')), h('span', { 'aria-hidden': 'true' }, '▾'));
  folderButton.title = state.root ?? '';
  $('refresh').hidden = !ready;
  $('env-label').hidden = !ready;
  $('env-add').hidden = !ready;
  $('shell').classList.toggle('no-sidebar', !ready);
  if (ready) {
    const select = $('env');
    select.replaceChildren(
      h('option', { value: '' }, 'None'),
      ...state.listing.environments.map(path => h('option', { value: path, selected: path === state.environment }, path))
    );
    select.value = state.environment ?? '';
  }
  renderBanner();
}

export function renderBanner() {
  const banner = $('banner');
  banner.replaceChildren();
  if (state.info?.icon !== 'offer' || !state.info?.tinyprobe) return;
  const where = { windows: 'the Start menu and the desktop', macos: 'Applications', linux: 'the applications menu' }[state.info.platform];
  banner.append(h('div', { class: 'banner' },
    h('p', null, `Add tinyprobe to ${where}? The icon starts the app; closing its window stops it.`),
    h('button', { type: 'button', class: 'button primary small', onclick: () => icon('create') }, 'Add icon'),
    h('button', { type: 'button', class: 'button small', onclick: () => icon('decline') }, 'Not now')));
}

export async function icon(action) {
  try {
    state.info = await api('/api/icon', { action });
    renderBanner();
    if (action === 'create') showMessage('The tinyprobe icon is ready.', 'info');
  } catch (e) {
    if (!(e instanceof RestartError)) showMessage(`The icon could not be added: ${e.message}`);
  }
}

export function renderSidebar() {
  const sidebar = $('sidebar');
  const m = state.model;
  sidebar.hidden = !m;
  $('nav-toggle').hidden = !m;
  if (!m) return;

  const selected = state.selection;
  const isSelected = (kind, file, name) => selected.kind === kind && selected.file === file && (name === undefined || selected.name === name);

  const groups = [];
  // The overview, the environment and the history first: the list of endpoints can be long.
  groups.push(h('div', { class: 'group' }, h('ul', { class: 'tree' },
    h('li', null, item({ label: 'Overview', mark: '⌂', selected: selected.kind === 'home', onclick: () => select({ kind: 'home' }) })),
    h('li', null, item({ mark: '⚙', label: state.environment ? `Environment: ${baseName(state.environment)}` : 'Environment', selected: selected.kind === 'environment', onclick: () => select({ kind: 'environment' }) })),
    h('li', null, item({ mark: '↺', label: state.history.length > 0 ? `History (${state.history.length})` : 'History', selected: selected.kind === 'history', onclick: () => select({ kind: 'history' }) })))));

  const endpointCount = m.apis.reduce((sum, file) => sum + file.endpoints.length, 0);
  const apiOpen = isOpen('api', true);
  const apiGroup = h('div', { class: 'group' }, groupTitle('api', 'API', endpointCount, true));
  const tree = h('ul', { class: 'tree', hidden: !apiOpen });
  for (const file of m.apis) {
    // A file is open when it holds what is selected, or when it is the only one.
    const holds = selected.file === file.path;
    const fileOpen = isOpen(`file:${file.path}`, holds || m.apis.length === 1);
    tree.append(h('li', null, h('button', {
      type: 'button', class: 'file', 'aria-expanded': String(fileOpen), title: file.path,
      onclick: () => toggleOpen(`file:${file.path}`, holds || m.apis.length === 1)
    }, h('span', { class: 'chevron' }, fileOpen ? '▾' : '▸'), h('span', { class: 'label' }, file.workflow ? `${file.path} (workflow)` : file.path), h('span', { class: 'group-count' }, file.endpoints.length))));
    if (!fileOpen) continue;
    for (const endpoint of file.endpoints) {
      tree.append(h('li', null, item({
        verb: endpoint.method,
        label: endpoint.name,
        selected: isSelected('endpoint', file.path, endpoint.name),
        onclick: () => select({ kind: 'endpoint', file: file.path, name: endpoint.name })
      })));
    }
    if (state.info.editing && !file.workflow) {
      tree.append(h('li', null, item({ mark: '🔑', label: 'Auth sets', selected: isSelected('auth', file.path), onclick: () => select({ kind: 'auth', file: file.path }) })));
    }
  }
  tree.append(h('li', null, item({ label: '+ New request', className: 'add', selected: selected.kind === 'new', onclick: () => select({ kind: 'new' }) })));
  apiGroup.append(tree);
  groups.push(apiGroup);

  if (m.workflows.length > 0 || state.info.editing) {
    const list = h('ul', { class: 'tree' });
    for (const workflow of m.workflows) {
      const outcome = state.outcomes.get(workflow.path);
      list.append(h('li', null, item({
        mark: outcome ? (outcome.success ? '✓' : '✗') : '○',
        markClass: outcome ? (outcome.success ? 'passed' : 'failed') : '',
        label: workflow.name,
        title: workflow.path,
        selected: isSelected('workflow', workflow.path),
        onclick: () => select({ kind: 'workflow', file: workflow.path })
      })));
    }
    if (state.info.editing) list.append(h('li', null, item({ label: '+ New workflow', className: 'add', selected: selected.kind === 'new-workflow', onclick: () => select({ kind: 'new-workflow' }) })));
    list.hidden = !isOpen('workflows', true);
    groups.push(h('div', { class: 'group' }, groupTitle('workflows', 'Workflows', m.workflows.length, true), list));
  }

  if (m.sequences.length > 0) {
    const list = h('ul', { class: 'tree' });
    for (const sequence of m.sequences) {
      list.append(h('li', null, item({
        mark: '↳', label: sequence.name, title: sequence.path,
        selected: isSelected('sequence', sequence.path),
        onclick: () => select({ kind: 'sequence', file: sequence.path })
      })));
    }
    list.hidden = !isOpen('sequences', true);
    groups.push(h('div', { class: 'group' }, groupTitle('sequences', 'Sequences', m.sequences.length, true), list));
  }

  if (m.invalid.length > 0) {
    const list = h('ul', { class: 'tree' });
    for (const file of m.invalid) {
      list.append(h('li', null, item({ mark: '!', markClass: 'invalid', label: file.path, onclick: () => select({ kind: 'home' }) })));
    }
    groups.push(h('div', { class: 'group' }, h('div', { class: 'group-title' }, h('span', null, 'Not valid')), list));
  }

  if (state.environment) {
    groups.push(h('div', { class: 'variables' },
      h('div', null, `Variables of ${baseName(state.environment)}`),
      state.variables.length > 0 ? h('ul', null, state.variables.map(name => h('li', null, name))) : h('div', null, 'None')));
  }
  sidebar.replaceChildren(...groups);
}

/** Whether a group of the sidebar is open, remembered for each folder. */
export function isOpen(id, fallback) {
  return recall(`open:${state.root}:${id}`, fallback);
}

export function toggleOpen(id, fallback) {
  remember(`open:${state.root}:${id}`, !isOpen(id, fallback));
  renderSidebar();
}

export function groupTitle(id, label, count, fallback) {
  const open = isOpen(id, fallback);
  return h('button', { type: 'button', class: 'group-title group-toggle', 'aria-expanded': String(open), onclick: () => toggleOpen(id, fallback) },
    h('span', null, `${open ? '▾' : '▸'} ${label}`), h('span', { class: 'group-count' }, count));
}

export function item({ label, verb, mark, markClass, title, selected, onclick, className }) {
  return h('button', { type: 'button', class: `item${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`, title: title ?? label, onclick, 'aria-current': selected ? 'true' : null },
    verb ? h('span', { class: `verb verb-${verb}` }, verb) : mark ? h('span', { class: `mark ${markClass ?? ''}` }, mark) : null,
    h('span', { class: 'label' }, label));
}

/** The view a result belongs to: a workflow, an endpoint, the overview, the history. */
export function ownerOf(selection) {
  return `${selection.kind}:${selection.file ?? ''}:${selection.name ?? ''}`;
}

/** Only the results of the view on screen are shown; the others come back with their view. */
export function showOwnResults() {
  const owner = ownerOf(state.selection);
  for (const node of $('results').children) {
    if (node.dataset.owner) node.hidden = node.dataset.owner !== owner;
  }
}

// The drawer of the files on a phone: under the top bar, closed by a choice, the backdrop or Escape
// (wired in the events at the end).
export function setNav(open) {
  if (open) document.documentElement.style.setProperty('--topbar-height', `${document.querySelector('.topbar').offsetHeight}px`);
  document.body.classList.toggle('nav-open', open);
  $('nav-toggle').setAttribute('aria-expanded', String(open));
}

export function select(selection) {
  state.selection = selection;
  setNav(false);
  renderSidebar();
  renderView();
  $('view').scrollIntoView({ block: 'start' });
}

/** renderView once for many events: a run's events come faster than a screen refreshes (a timer for a hidden tab). */
export let viewPending = null;
export function renderViewSoon() {
  if (viewPending) return;
  viewPending = { timer: setTimeout(renderViewNow, 100), frame: requestAnimationFrame(renderViewNow) };
}

export function renderViewNow() {
  if (viewPending) {
    clearTimeout(viewPending.timer);
    cancelAnimationFrame(viewPending.frame);
    viewPending = null;
  }
  renderView();
}

export function renderView() {
  const view = $('view');
  if (!state.info) return;
  if (!state.info.tinyprobe) return view.replaceChildren(installView());
  if (!state.root || !state.model) return view.replaceChildren(welcomeView());
  const s = state.selection;
  const content =
    s.kind === 'endpoint' ? endpointView(s) :
    s.kind === 'workflow' ? workflowView(s) :
    s.kind === 'sequence' ? sequenceView(s) :
    s.kind === 'new' ? newRequestView() :
    s.kind === 'environment' ? environmentView() :
    s.kind === 'edit-endpoint' ? endpointEditView(s) :
    s.kind === 'yaml' ? yamlView(s) :
    s.kind === 'auth' ? authView(s) :
    s.kind === 'edit-step' ? stepEditView(s) :
    s.kind === 'new-workflow' ? newWorkflowView() :
    s.kind === 'history' ? historyView() :
    homeView();
  view.replaceChildren(content ?? homeView());
  showOwnResults();
}
