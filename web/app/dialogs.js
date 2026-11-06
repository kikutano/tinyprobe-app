// Dialogs: the folders, the settings, and the versions with their updates.
import { $, api, h, nodes, query, RestartError, state } from './base.js';
import { icon, render } from './render.js';
import { openRoot } from './start.js';

// --- Folders dialog --------------------------------------------------------------------------------------

export async function openFolderDialog(start) {
  const dialog = $('folders');
  const body = $('folders-body');
  async function show(path) {
    let listing;
    try {
      listing = await api(`/api/browse?${query({ path: path ?? '' })}`);
    } catch (e) {
      if (e instanceof RestartError) return;
      body.prepend(h('div', { class: 'notice' }, e.message));
      return;
    }
    const recent = state.info.folders.filter(f => f.exists && f.path !== state.root);
    body.replaceChildren(...nodes(
      recent.length > 0 ? h('div', { class: 'group' },
        h('div', { class: 'group-title' }, h('span', null, 'Recent')),
        h('ul', { class: 'recent' }, recent.map(f => h('li', null,
          h('button', { type: 'button', class: 'item', title: f.path, onclick: () => { dialog.close(); openRoot(f.path); } }, h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, f.path)),
          h('button', { type: 'button', class: 'icon-button', 'aria-label': `Forget ${f.path}`, title: 'Remove from the list', onclick: async () => { state.info = await api('/api/folders/remove', { root: f.path }); show(listing.path); } }, '✕'))))) : null,
      h('div', { class: 'crumb' }, listing.path || 'This computer'),
      h('div', { class: 'actions' },
        listing.parent !== null ? h('button', { type: 'button', class: 'button small', onclick: () => show(listing.parent) }, '↑ Up') : null,
        listing.path ? h('button', { type: 'button', class: 'button primary small', onclick: () => choose(listing.path) }, 'Open this folder') : null),
      h('ul', { class: 'browse' }, listing.folders.length === 0
        ? h('li', { class: 'aside empty-row' }, 'No folders inside.')
        : listing.folders.map(f => h('li', null,
          h('button', { type: 'button', class: 'item', onclick: () => show(f.path), ondblclick: () => choose(f.path) },
            h('span', { class: 'mark' }, '📁'), h('span', { class: 'label' }, f.name),
            f.tinyprobe ? h('span', { class: 'badge-tests' }, 'tinyprobe/') : null)))),
      h('p', { class: 'aside' }, 'A folder with a tinyprobe/ folder opens on its tests.')));
  }
  async function choose(path) {
    try {
      const { root } = await api('/api/folders/open', { path });
      state.info = await api('/api/state');
      dialog.close();
      await openRoot(root);
    } catch (e) {
      if (!(e instanceof RestartError)) body.prepend(h('div', { class: 'notice' }, e.message));
    }
  }
  await show(start ?? (state.root ? state.root : state.info.home));
  if (!dialog.open) dialog.showModal();
}

// --- Settings --------------------------------------------------------------------------------------------

export function openSettings() {
  const dialog = $('settings');
  const body = $('settings-body');
  const info = state.info;
  const cli = info?.tinyprobe;
  const output = h('pre', { class: 'body', hidden: true });
  body.replaceChildren(...nodes(
    updatesSection(output),
    h('dl', { class: 'pairs-settings' },
      h('dt', null, 'App'), h('dd', null, `tinyprobe-app ${info?.app ?? ''}`),
      h('dt', null, 'tinyprobe'), h('dd', null, cli ? `${cli.version}` : `not installed (${info?.minimum} or newer is needed)`),
      cli ? h('dt', null, 'Binary') : null, cli ? h('dd', { class: 'mono' }, cli.path) : null,
      cli ? h('dt', null, 'Source') : null,
      cli ? h('dd', null, { path: 'your installation (on the PATH): update it as you installed it', app: "the app's own copy", env: 'TINYPROBE_PATH' }[cli.source] ?? cli.source) : null),
    info?.problem ? h('p', { class: 'aside' }, info.problem) : null,
    h('div', { class: 'actions' },
      info?.icon !== 'unsupported' ? h('button', { type: 'button', class: 'button small', onclick: () => icon('create') }, info?.icon === 'created' ? 'Add the icon again' : 'Add the tinyprobe icon') : null),
    output,
    h('p', { class: 'aside' }, 'The app runs on this computer only (127.0.0.1). Requests and responses, Authorization headers included, are shown here and are not sent anywhere else. The only other request is the check for new versions, which asks GitHub for the latest release and sends nothing.')));
  dialog.showModal();
}

// --- Versions and updates ---------------------------------------------------------------------------------

export async function checkUpdates(now = false) {
  try {
    state.updates = await api(`/api/updates${now ? '?now=1' : ''}`);
  } catch {
    state.updates = null;
  }
  renderVersions();
}

/** The versions next to the name, and a notice when the app or tinyprobe is behind, or the editor needs 0.21. */
export function renderVersions() {
  const info = state.info;
  const u = state.updates;
  const cli = info?.tinyprobe;
  $('versions').textContent = info ? `app ${info.app}${cli ? ` · tinyprobe ${cli.version}` : ''}` : '';
  const reasons = [
    u?.app_outdated ? `app ${u.latest_app}` : null,
    u?.tinyprobe_outdated ? `tinyprobe ${u.latest_tinyprobe}` : null,
    cli && !info.editing ? 'the visual editor needs tinyprobe 0.21' : null
  ].filter(Boolean);
  const badge = $('update-badge');
  badge.hidden = reasons.length === 0;
  badge.textContent = '↑ Update';
  badge.title = `New: ${reasons.join(', ')}. Click for how to update.`;
}

export function updatesSection(output) {
  const u = state.updates;
  const cli = state.info?.tinyprobe;
  const line = (label, current, latest, outdated, how) => h('div', { class: 'version-row' },
    h('span', null, h('strong', null, label), ` ${current ?? 'not installed'}`),
    latest ? h('span', { class: outdated ? 'version-new' : 'aside' }, outdated ? `${latest} is out` : 'up to date') : null,
    outdated ? how : null);
  const updateCli = cli?.source === 'app' ? h('button', { type: 'button', class: 'button small', onclick: async event => {
    event.target.disabled = true;
    output.hidden = false;
    output.textContent = 'Updating tinyprobe…';
    try {
      const result = await api('/api/tinyprobe/update', {});
      output.textContent = result.output || 'Up to date.';
      state.info = await api('/api/state');
      await checkUpdates();
      render();
    } catch (e) {
      output.textContent = e.message;
    }
  } }, 'Update tinyprobe') : h('code', null, 'tinyprobe update');
  return h('div', { class: 'versions-section' },
    line('tinyprobe-app', state.info?.app, u?.latest_app, u?.app_outdated,
      h('span', { class: 'aside' }, 'Run the install command again: ', h('code', null, 'curl -fsSL https://raw.githubusercontent.com/kikutano/tinyprobe-app/main/install.sh | sh'))),
    line('tinyprobe', cli?.version, u?.latest_tinyprobe, u?.tinyprobe_outdated || (cli && !state.info.editing), updateCli),
    cli && !state.info.editing ? h('p', { class: 'aside' }, 'The visual editor (Edit, YAML, Auth sets, New workflow) needs tinyprobe 0.21.0 or newer.') : null,
    h('label', { class: 'check', for: 'check-updates' },
      h('input', { type: 'checkbox', id: 'check-updates', checked: u?.check ?? true, onchange: async event => {
        state.updates = await api('/api/updates', { check: event.target.checked }).catch(() => state.updates);
        renderVersions();
      } }),
      ' Check GitHub for new versions once a day'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button small', onclick: async () => { await checkUpdates(true); openSettings(); } }, 'Check now'),
      u?.checked_at ? h('span', { class: 'aside' }, `Last checked ${new Date(u.checked_at).toLocaleString()}`) : null));
}
