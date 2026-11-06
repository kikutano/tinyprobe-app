// The first views: tinyprobe missing, no folder yet, and the overview of a folder.
import { api, baseName, h, RestartError, runView, state } from '../base.js';
import { openFolderDialog } from '../dialogs.js';
import { select } from '../render.js';
import { runAll, runWorkflow } from '../runs.js';
import { boot, openRoot } from '../start.js';

// --- tinyprobe missing -----------------------------------------------------------------------------------

export function installView() {
  const status = h('p', { class: 'lead', 'aria-live': 'polite' });
  const button = h('button', { type: 'button', class: 'button primary', onclick: download }, `Download tinyprobe`);
  async function download() {
    button.disabled = true;
    status.textContent = 'Downloading tinyprobe (about 4 MB) and checking its checksum…';
    status.classList.remove('error-text');
    try {
      state.info = await api('/api/tinyprobe/download', {});
      await boot();
    } catch (e) {
      if (e instanceof RestartError) return;
      button.disabled = false;
      status.textContent = e.message;
      status.classList.add('error-text');
    }
  }
  return h('div', { class: 'welcome' },
    h('h1', null, 'tinyprobe is needed'),
    h('p', { class: 'lead' }, `The app sends your requests and runs your workflows with tinyprobe ${state.info.minimum} or newer. It downloads it from the tinyprobe releases on GitHub into its own folder; a tinyprobe you install yourself is used instead.`),
    state.info.problem ? h('p', { class: 'aside' }, state.info.problem) : null,
    h('div', { class: 'actions' }, button, h('a', { class: 'link', href: 'https://github.com/kikutano/tinyprobe#install', target: '_blank', rel: 'noreferrer' }, 'Install it yourself')),
    status);
}

// --- No folder yet ---------------------------------------------------------------------------------------

export function welcomeView() {
  const folders = state.info.folders;
  return h('div', { class: 'welcome' },
    h('h1', null, 'Open the folder of your API tests'),
    h('p', { class: 'lead' }, 'tinyprobe works on the YAML files of a folder, usually the tinyprobe/ folder of a project. The app reads them, sends their requests and runs their workflows; the same files run with tinyprobe in a terminal and in CI.'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button primary', onclick: () => openFolderDialog() }, 'Open a folder…')),
    folders.length > 0 ? h('h2', null, 'Recent folders') : null,
    folders.length > 0 ? h('ul', { class: 'recent' }, folders.map(folder => h('li', null,
      h('button', { type: 'button', class: `item${folder.exists ? '' : ' missing'}`, disabled: !folder.exists, title: folder.path, onclick: () => openRoot(folder.path) },
        h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, folder.path))))) : null);
}

// --- Overview of the folder ------------------------------------------------------------------------------

/** "3 min ago" for a time in milliseconds. */
function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Every workflow of the folder with the last whole run of it: the state of the folder at a glance. */
function workflowTable(workflows) {
  const outcomes = workflows.map(w => state.outcomes.get(w.path));
  const passed = outcomes.filter(o => o?.success).length;
  const failed = outcomes.filter(o => o && !o.success).length;
  const never = outcomes.filter(o => !o).length;
  const totals = [passed ? `${passed} passed` : null, failed ? `${failed} failed` : null, never ? `${never} not run yet` : null].filter(Boolean);
  return h('section', { class: 'workflow-table' },
    h('h2', null, 'Workflows', h('span', { class: 'totals' }, totals.join(' · '))),
    h('ul', null, workflows.map((workflow, i) => {
      const o = outcomes[i];
      const steps = (workflow.inspect.steps ?? []).length;
      return h('li', { class: `workflow-row ${o ? (o.success ? 'passed' : 'failed') : ''}` },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, o ? (o.success ? '✓' : '✗') : '○'),
        h('span', { class: 'what' },
          h('button', { type: 'button', class: 'link', onclick: () => select({ kind: 'workflow', file: workflow.path }) }, workflow.name),
          h('span', { class: 'file' }, `${workflow.path} · ${steps} ${steps === 1 ? 'step' : 'steps'}`)),
        h('span', { class: 'last', title: o?.environment ? `with ${o.environment}` : '' }, o
          ? `${o.passed}/${o.total} passed${o.failed ? ` · ${o.failed} failed` : ''} · ${runView.formatDuration(o.duration)} · ${ago(o.at)}`
          : 'not run yet'),
        h('button', { type: 'button', class: 'button small', title: `Run ${workflow.name}`, onclick: () => runWorkflow(workflow) }, '▶ Run'));
    })));
}

export function homeView() {
  const m = state.model;
  const endpoints = m.apis.reduce((sum, file) => sum + file.endpoints.length, 0);
  const empty = endpoints === 0 && m.workflows.length === 0 && m.sequences.length === 0 && m.invalid.length === 0;
  return h('div', null,
    h('h1', null, baseName(state.root)),
    h('div', { class: 'where' }, state.root),
    h('div', { class: 'counts' },
      h('span', { class: 'count' }, h('strong', null, endpoints), endpoints === 1 ? 'endpoint' : 'endpoints'),
      h('span', { class: 'count' }, h('strong', null, m.workflows.length), m.workflows.length === 1 ? 'workflow' : 'workflows'),
      m.sequences.length > 0 ? h('span', { class: 'count' }, h('strong', null, m.sequences.length), m.sequences.length === 1 ? 'sequence' : 'sequences') : null,
      h('span', { class: 'count' }, h('strong', null, state.listing.environments.length), state.listing.environments.length === 1 ? 'environment' : 'environments')),
    h('div', { class: 'actions' },
      m.workflows.length > 0 ? h('button', { type: 'button', class: 'button primary', onclick: runAll }, '▶ Run all workflows') : null,
      h('button', { type: 'button', class: 'button', onclick: () => select({ kind: 'new' }) }, '+ New request')),
    state.listing.truncated ? h('div', { class: 'notice info' }, `Only the first 500 YAML files are listed: open the tinyprobe/ folder of the project instead of the whole project.`) : null,
    m.workflows.length > 0 ? workflowTable(m.workflows) : null,
    m.invalid.length > 0 ? h('div', { class: 'notice' },
      h('strong', null, m.invalid.length === 1 ? '1 file is not valid' : `${m.invalid.length} files are not valid`),
      h('ul', null, m.invalid.flatMap(file => file.errors.map(e => h('li', null, e.text))))) : null,
    empty ? h('div', { class: 'notice info' },
      h('strong', null, 'No tinyprobe files here yet. '),
      'Add a request with + New request, or ask your coding agent to write them: the prompts are in the ',
      h('a', { class: 'link', href: 'https://github.com/kikutano/tinyprobe#migrate-with-your-ai', target: '_blank', rel: 'noreferrer' }, 'tinyprobe README'), '.') : null,
    h('p', { class: 'aside' }, 'A request sent from here remembers nothing for the next one. To pass a token or an id from one request to another, a workflow saves it with save: and every run starts from zero.'));
}
