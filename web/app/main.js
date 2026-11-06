// tinyprobe-app: the page. It shows what `tinyprobe inspect --json` says about the files of a folder, and runs
// `tinyprobe call` and `tinyprobe run` through the launcher, rendering their ndjson events with the run view
// shared with the VS Code extension. Every value from files and runs is set with textContent, never as HTML.
import { $, remember, state } from './base.js';
import { openFolderDialog, openSettings } from './dialogs.js';
import { renderSidebar, renderView, setNav } from './render.js';
import { boot, loadListing, loadVariables } from './start.js';
import { openNewEnvironment } from './views/environment.js';

// --- Events ----------------------------------------------------------------------------------------------

$('nav-toggle').addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
$('nav-backdrop').addEventListener('click', () => setNav(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setNav(false); });
$('folder-button').addEventListener('click', () => openFolderDialog());
$('settings-button').addEventListener('click', openSettings);
$('update-badge').addEventListener('click', openSettings);
$('env-add').addEventListener('click', () => openNewEnvironment());
$('refresh').addEventListener('click', () => loadListing());
$('env').addEventListener('change', async event => {
  state.environment = event.target.value || null;
  remember(`env:${state.root}`, state.environment);
  await loadVariables();
  renderSidebar();
  renderView();
});

// The user edits the YAML in an editor at the same time: read the folder again when the page comes back.
let refreshing = null;
window.addEventListener('focus', () => {
  if (!state.root || refreshing) return;
  refreshing = setTimeout(async () => {
    await loadListing({ quiet: true });
    refreshing = null;
  }, 150);
});

boot();
