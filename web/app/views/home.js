// The first views: tinyprobe missing, no folder yet, and the overview of a folder.
import { api, baseName, h, state } from '../base.js';
import { openFolderDialog } from '../dialogs.js';
import { select } from '../render.js';
import { runAll } from '../runs.js';
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
    m.invalid.length > 0 ? h('div', { class: 'notice' },
      h('strong', null, m.invalid.length === 1 ? '1 file is not valid' : `${m.invalid.length} files are not valid`),
      h('ul', null, m.invalid.flatMap(file => file.errors.map(e => h('li', null, e.text))))) : null,
    empty ? h('div', { class: 'notice info' },
      h('strong', null, 'No tinyprobe files here yet. '),
      'Add a request with + New request, or ask your coding agent to write them: the prompts are in the ',
      h('a', { class: 'link', href: 'https://github.com/kikutano/tinyprobe#migrate-with-your-ai', target: '_blank', rel: 'noreferrer' }, 'tinyprobe README'), '.') : null,
    h('p', { class: 'aside' }, 'A request sent from here remembers nothing for the next one. To pass a token or an id from one request to another, a workflow saves it with save: and every run starts from zero.'));
}
