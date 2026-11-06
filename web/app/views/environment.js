// The environment: its variables edited in place, and a new environment file.
import { $, api, baseName, envFile, h, query, remember, showMessage, state, text } from '../base.js';
import { renderSidebar, select } from '../render.js';
import { loadListing } from '../start.js';

// --- Environment -------------------------------------------------------------------------------------------

/**
 * The variables of the selected environment file, edited in place: each change rewrites only that variable's
 * lines, so the file keeps its comments and order. Names that look like secrets are hidden until shown.
 */
export function environmentView() {
  if (state.listing.environments.length === 0) {
    return h('div', null,
      h('h1', null, 'Environment'),
      h('p', { class: 'lead' }, 'An environment file holds the values your requests use: the base URL, the credentials. This folder has none yet.'),
      h('p', { class: 'aside' }, 'Create env.local.yaml in the folder (tinyprobe init does it for a project), with lines such as baseUrl: http://localhost:8080/. Keep files with credentials out of Git.'));
  }
  if (!state.environment) {
    return h('div', null,
      h('h1', null, 'Environment'),
      h('p', { class: 'lead' }, 'Pick the environment at the top: its values go into every request and run.'));
  }

  const container = h('div', null, h('p', { class: 'aside' }, 'Reading the file…'));
  const status = h('div', { 'aria-live': 'polite' });
  const path = state.environment;
  let content = null;

  async function load() {
    content = await text(`/api/file?${query({ root: state.root, path })}`).catch(() => null);
    draw();
  }

  async function write(next, message) {
    status.replaceChildren();
    try {
      await api('/api/environment', { root: state.root, path, text: next, basis: content });
      content = next;
      state.variables = envFile.parse(content).map(v => v.name);
      renderSidebar();
      draw();
      showMessage(message, 'info');
    } catch (e) {
      if (e instanceof RestartError) return;
      if (e.status === 409) {
        await load();
        status.append(h('div', { class: 'notice' }, 'The file changed on disk: it was read again. Make the change again.'));
      } else {
        status.append(h('div', { class: 'notice' }, e.message));
      }
    }
  }

  function draw() {
    if (content === null) {
      container.replaceChildren(h('div', { class: 'notice' }, `${path} cannot be read.`));
      return;
    }
    const variables = envFile.parse(content);
    const rows = variables.map(variable => {
      const secret = envFile.isSecretName(variable.name);
      const editable = variable.kind !== 'block';
      const current = variable.kind === 'scalar' ? variable.value : variable.raw;
      const save = () => {
        if (input.value !== current) write(envFile.setValue(content, variable, input.value), `${variable.name} saved in ${baseName(path)}.`);
      };
      const input = h('input', {
        class: 'input mono', id: `env-${variable.name}`, value: editable ? current : variable.value,
        type: secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', disabled: !editable,
        onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }
      });
      return [
        h('label', { for: `env-${variable.name}` }, variable.name),
        h('div', { class: 'field' }, input,
          secret ? h('button', { type: 'button', class: 'icon-button', title: 'Show or hide the value', 'aria-label': `Show or hide ${variable.name}`, onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, '👁') : h('span', { class: 'icon-space' }),
          editable ? h('button', { type: 'button', class: 'button small', onclick: save }, 'Save') : h('span', { class: 'default' }, 'edit it in the file'),
          h('button', { type: 'button', class: 'icon-button', title: `Delete ${variable.name}`, 'aria-label': `Delete ${variable.name}`, onclick: () => {
            if (confirm(`Delete ${variable.name} from ${baseName(path)}?`)) write(envFile.removeVariable(content, variable), `${variable.name} deleted.`);
          } }, '✕'))
      ];
    });

    const name = h('input', { class: 'input mono', id: 'env-new-name', placeholder: 'apiKey', autocomplete: 'off', spellcheck: 'false' });
    const value = h('input', { class: 'input mono', id: 'env-new-value', placeholder: 'value', autocomplete: 'off', spellcheck: 'false' });
    const add = h('form', { onsubmit: event => {
      event.preventDefault();
      status.replaceChildren();
      const chosen = name.value.trim();
      const problem = envFile.checkName(chosen, variables.map(v => v.name));
      if (problem) return status.append(h('div', { class: 'notice' }, problem));
      write(envFile.addVariable(content, chosen, value.value), `${chosen} added to ${baseName(path)}.`);
    } },
      h('h2', null, 'Add a variable'),
      h('div', { class: 'form' },
        h('label', { for: 'env-new-name' }, 'Name'), name,
        h('label', { for: 'env-new-value' }, 'Value'), h('div', { class: 'field' }, value, h('button', { type: 'submit', class: 'button primary small' }, 'Add'))));

    container.replaceChildren(
      variables.length > 0 ? h('div', { class: 'form' }, rows.flat()) : h('p', { class: 'aside' }, 'No variables yet.'),
      add);
  }

  queueMicrotask(load);
  return h('div', null,
    h('div', { class: 'title-row' }, h('h1', null, 'Environment'), h('span', { class: 'spacer' }),
      h('div', { class: 'title-actions' },
        h('button', { type: 'button', class: 'button small', onclick: () => openNewEnvironment(path) }, 'Duplicate'),
        h('button', { type: 'button', class: 'button small', onclick: () => openNewEnvironment() }, 'New'))),
    h('div', { class: 'where' }, path),
    h('p', { class: 'lead' }, 'Values are read like YAML: 42 is a number, true a boolean, "42" a string. A change is written to the file at once, its comments and order kept.'),
    status,
    container,
    h('p', { class: 'aside' }, 'Names that look like secrets (password, token, apiKey…) are hidden until you show them. Keep files with credentials out of Git.'));
}

// --- New environment ---------------------------------------------------------------------------------------

/** A new environment file next to the others: empty, or a copy of one to change only some values. */
export function openNewEnvironment(copyOf = null) {
  const dialog = $('env-dialog');
  const status = h('div', { 'aria-live': 'polite' });
  const name = h('input', { class: 'input mono', id: 'env-new-file', placeholder: 'staging', autocomplete: 'off', spellcheck: 'false' });
  const from = h('select', { class: 'select', id: 'env-new-from' },
    h('option', { value: '' }, 'Empty'),
    state.listing.environments.map(path => h('option', { value: path, selected: path === copyOf }, `A copy of ${path}`)));
  const fileName = () => {
    const slug = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `env.${slug}.yaml` : null;
  };
  const preview = h('div', { class: 'hint' }, 'The file: env.<name>.yaml, in the folder.');
  name.addEventListener('input', () => { preview.textContent = fileName() ? `The file: ${fileName()}` : 'The file: env.<name>.yaml, in the folder.'; });
  $('env-dialog-title').textContent = copyOf ? `Duplicate ${baseName(copyOf)}` : 'New environment';
  $('env-dialog-body').replaceChildren(h('form', { onsubmit: async event => {
    event.preventDefault();
    status.replaceChildren();
    const path = fileName();
    if (!path) return status.append(h('div', { class: 'notice' }, 'Give the environment a name, e.g. staging'));
    if (state.listing.environments.includes(path) || state.listing.files.some(f => f.path === path)) return status.append(h('div', { class: 'notice' }, `${path} already exists.`));
    let content = `# The values of the requests for ${name.value.trim()}. Keep files with credentials out of Git.\nbaseUrl: http://localhost:8080/\n`;
    if (from.value) {
      content = await text(`/api/file?${query({ root: state.root, path: from.value })}`).catch(() => null);
      if (content === null) return status.append(h('div', { class: 'notice' }, `${from.value} cannot be read.`));
    }
    try {
      await api('/api/environment', { root: state.root, path, text: content, basis: null, create: true });
    } catch (e) {
      if (!(e instanceof RestartError)) status.append(h('div', { class: 'notice' }, e.message));
      return;
    }
    dialog.close();
    state.environment = path;
    remember(`env:${state.root}`, path);
    await loadListing();
    select({ kind: 'environment' });
    showMessage(`Created ${path}${from.value ? ` from ${from.value}` : ''}: change the values that differ.`, 'info');
  } },
    h('div', { class: 'form' },
      h('label', { for: 'env-new-file' }, 'Name'), name, preview,
      h('label', { for: 'env-new-from' }, 'Start from'), from),
    h('p', { class: 'aside' }, 'A copy keeps every value and comment of the original: change only what differs, such as baseUrl.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Create')),
    status));
  dialog.showModal();
  name.focus();
}
