// The visual editor: the files read with inspect --source, a block as YAML, and auth sets.
import { $, api, control, editing, h, query, showMessage, state, text } from '../base.js';
import { renderView, select } from '../render.js';
import { loadListing } from '../start.js';
import { newRequestView } from './request.js';

// --- Visual editor (M5-4) ----------------------------------------------------------------------------------
//
// Every form reads the file with `inspect --source` (tinyprobe spec 0018), rewrites one block of its text, and
// saves it through /api/save, where tinyprobe checks it: a change it does not accept leaves the file as it was.

export const EDITING_NEEDED = 'Editing files needs tinyprobe 0.21.0 or newer: update it from Settings, or with tinyprobe update.';

export function blockOf(source, kind, key) {
  return (source.inspect?.blocks ?? []).find(b => b.kind === kind && (kind === 'step' ? b.index === key : b.name === key)) ?? null;
}

/** A view that first reads a file as written, then shows what `build` makes of it. */
export function editorShell(title, file, build) {
  const container = h('div', null, h('p', { class: 'aside' }, 'Reading the file…'));
  queueMicrotask(async () => {
    try {
      const source = await api(`/api/source?${query({ root: state.root, path: file })}`);
      container.replaceChildren(build(source));
    } catch (e) {
      if (!(e instanceof RestartError)) container.replaceChildren(h('div', { class: 'notice' }, e.message));
    }
  });
  return title === null ? container : h('div', null, h('h1', null, title), h('div', { class: 'where' }, file), container);
}

/** Saves a changed file; returns whether tinyprobe accepted it, and says why not in `status`. */
export async function saveFile(file, next, basis, status) {
  status.replaceChildren();
  try {
    const answer = await api('/api/save', { root: state.root, path: file, text: next, basis });
    if (!answer.saved) {
      status.append(h('div', { class: 'notice' },
        h('strong', null, 'Not saved: tinyprobe does not accept the file with this change. The file is as it was.'),
        h('ul', null, (answer.inspect?.errors ?? []).map(e => h('li', null, e.text)))));
      return false;
    }
    await loadListing();
    return true;
  } catch (e) {
    if (!(e instanceof RestartError)) {
      status.append(h('div', { class: 'notice' }, e.status === 409 ? 'The file changed on disk since it was read: open it again to edit what is there now.' : e.message));
    }
    return false;
  }
}


/** What only YAML can say: the form stops there and offers the block as text. */
export function yamlOnly(what, file, block, back) {
  return h('div', null,
    h('div', { class: 'notice info' }, `This ${what} has ${block.reasons.join(', ')}: the form does not show ${block.reasons.length === 1 ? 'it' : 'them'}, so it is edited as YAML.`),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'button primary', onclick: () => select({ kind: 'yaml', file, block: block.key, back }) }, 'Edit as YAML'),
      h('button', { type: 'button', class: 'button', onclick: () => select(back) }, 'Cancel')));
}

export function endpointEditView({ file, name }) {
  return editorShell(null, file, source => {
    const block = blockOf(source, 'endpoint', name);
    const written = source.inspect?.source?.endpoints?.[name];
    if (!block || !written) return h('div', { class: 'notice' }, `${name} is not written in ${file}.`);
    const form = editing.requestFromSource(name, written);
    const reasons = form.unsupported ?? (String(form.auth).includes(',') ? ['several auth sets'] : null);
    const back = { kind: 'endpoint', file, name };
    if (reasons) return h('div', null, h('h1', null, `Edit ${name}`), yamlOnly('endpoint', file, { reasons, key: { kind: 'endpoint', name } }, back));
    const blockText = source.text.split('\n').slice(block.start.line - 1, block.end.line).join('\n');
    return newRequestView({ file, name, block, text: source.text, form, comments: /(^|\s)#/.test(blockText) });
  });
}

/** A block as text, for what the forms do not show: until, for_each, sequences, form bodies, schema checks… */
export function yamlView({ file, block: key, back }) {
  return editorShell('Edit as YAML', file, source => {
    const block = blockOf(source, key.kind, key.kind === 'step' ? key.index : key.name);
    if (!block) return h('div', { class: 'notice' }, 'This part of the file is no longer there.');
    const lines = source.text.split('\n');
    const original = lines.slice(block.start.line - 1, block.end.line).join('\n').replace(/\r/g, '');
    const area = control('textarea', { id: 'yaml-block', class: 'textarea', rows: Math.min(Math.max(original.split('\n').length + 2, 6), 30) });
    area.value = original;
    const status = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'button primary' }, 'Save');
    return h('form', { onsubmit: async event => {
      event.preventDefault();
      save.disabled = true;
      if (await saveFile(file, editing.replaceBlock(source.text, block, area.value), source.text, status)) {
        showMessage(`Saved in ${file}.`, 'info');
        select(back);
      }
      save.disabled = false;
    } },
      h('p', { class: 'lead' }, 'Only these lines of the file change; tinyprobe checks the file before it is kept. The format is in docs/workflow-format.md of tinyprobe.'),
      area,
      h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'button', onclick: () => select(back) }, 'Cancel')),
      status);
  });
}

export async function deleteBlock(file, kind, key, what, after) {
  if (!confirm(`Delete ${what} from ${file}?`)) return;
  const status = h('div');
  try {
    const source = await api(`/api/source?${query({ root: state.root, path: file })}`);
    const block = blockOf(source, kind, key);
    if (!block) return showMessage(`${what} is no longer in ${file}.`);
    if (await saveFile(file, editing.removeBlock(source.text, block), source.text, status)) {
      showMessage(`Deleted ${what}.`, 'info');
      after?.();
    } else {
      $('results').prepend(status);
    }
  } catch (e) {
    if (!(e instanceof RestartError)) showMessage(e.message);
  }
}

// --- Auth sets -----------------------------------------------------------------------------------------------

export function authView({ file, editingName = null }) {
  return editorShell('Auth sets', file, source => {
    const sets = source.inspect?.source?.auth ?? {};
    const names = Object.keys(sets);
    const status = h('div', { 'aria-live': 'polite' });
    const formArea = h('div');
    const describe = set => {
      const read = editing.authFromSource('', set);
      if (read.unsupported) return 'edited as YAML';
      return { bearer: `Bearer ${read.token}`, header: `${read.header}: ${read.value}`, basic: `Basic, user ${read.username}`, oauth2: `OAuth2 client credentials, ${read.tokenUrl}` }[read.kind];
    };

    function showForm(name) {
      const existing = name === null ? null : editing.authFromSource(name, sets[name]);
      if (existing?.unsupported) {
        formArea.replaceChildren(yamlOnly('auth set', file, { reasons: existing.unsupported, key: { kind: 'auth', name } }, { kind: 'auth', file }));
        return;
      }
      const value = existing ?? { name: '', kind: 'bearer', token: '${token}' };
      const kind = control('select', { id: 'auth-kind' },
        [['bearer', 'Bearer token'], ['header', 'API key in a header'], ['basic', 'Basic (user and password)'], ['oauth2', 'OAuth2 client credentials']].map(([k, label]) => h('option', { value: k, selected: value.kind === k }, label)));
      const nameInput = control('input', { id: 'auth-name', value: value.name, placeholder: 'bearer', readonly: name !== null });
      const fields = h('div', { class: 'form' });
      const inputs = {};
      const field = (key, label, placeholder, hint) => {
        inputs[key] = control('input', { id: `auth-${key}`, value: value[key] ?? '', placeholder });
        return [h('label', { for: `auth-${key}` }, label), inputs[key], hint ? h('div', { class: 'hint' }, hint) : null];
      };
      const drawFields = () => {
        const k = kind.value;
        for (const key of Object.keys(inputs)) delete inputs[key];
        fields.replaceChildren(...(
          k === 'bearer' ? field('token', 'Token', '${token}', 'Sent as Authorization: Bearer …; ${token} is usually saved by a log-in step, or set in the environment.')
          : k === 'header' ? [...field('header', 'Header', 'X-Api-Key'), ...field('value', 'Value', '${apiKey}')]
          : k === 'basic' ? [...field('username', 'User', '${username}'), ...field('password', 'Password', '${password}')]
          : [...field('tokenUrl', 'Token URL', '${baseUrl}oauth/token'), ...field('clientId', 'Client id', '${clientId}'), ...field('clientSecret', 'Client secret', '${clientSecret}'), ...field('scope', 'Scope', 'optional, e.g. orders:read')]
        ).flat());
      };
      kind.addEventListener('change', drawFields);
      drawFields();
      formArea.replaceChildren(h('form', { onsubmit: async event => {
        event.preventDefault();
        const auth = { name: nameInput.value.trim(), kind: kind.value };
        for (const [key, input] of Object.entries(inputs)) auth[key] = input.value.trim();
        const problem = name === null ? editing.checkAuthName(auth.name, names) : null;
        if (problem) return status.replaceChildren(h('div', { class: 'notice' }, problem));
        const next = name === null
          ? editing.addAuthSet(source.text, source.inspect.blocks, auth)
          : editing.replaceBlock(source.text, blockOf(source, 'auth', name), editing.authSetYaml(auth, editing.indentOf(blockOf(source, 'auth', name))));
        if (await saveFile(file, next, source.text, status)) {
          showMessage(`Saved the auth set ${auth.name} in ${file}.`, 'info');
          renderView();
        }
      } },
        h('h2', null, name === null ? 'New auth set' : `Edit ${name}`),
        h('div', { class: 'form' }, h('label', { for: 'auth-name' }, 'Name'), nameInput, h('label', { for: 'auth-kind' }, 'Kind'), kind),
        fields,
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Save'), h('button', { type: 'button', class: 'button', onclick: () => formArea.replaceChildren() }, 'Cancel'))));
    }

    queueMicrotask(() => { if (editingName) showForm(editingName); });
    return h('div', null,
      h('p', { class: 'lead' }, 'How the endpoints of this file authenticate: an endpoint names its auth set with auth:. Values such as ${token} come from a step that saves them, or from the environment.'),
      names.length === 0 ? h('p', { class: 'aside' }, 'No auth sets yet.') : h('ol', { class: 'step-table' }, names.map(n => h('li', null,
        h('span', { class: 'step-label' }, h('strong', null, n), h('div', { class: 'step-kind' }, describe(sets[n]))),
        h('button', { type: 'button', class: 'button small', onclick: () => showForm(n) }, 'Edit'),
        h('button', { type: 'button', class: 'button small', onclick: () => select({ kind: 'yaml', file, block: { kind: 'auth', name: n }, back: { kind: 'auth', file } }) }, 'YAML'),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': `Delete ${n}`, onclick: () => names.length === 1
          ? deleteBlock(file, 'key', 'auth', `the auth set ${n}`, renderView)
          : deleteBlock(file, 'auth', n, `the auth set ${n}`, renderView) }, '✕')))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button', onclick: () => showForm(null) }, '+ New auth set')),
      formArea,
      status);
  });
}
