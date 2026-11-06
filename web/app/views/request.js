// New request: the form of an endpoint, new or edited.
import { api, control, core, editing, h, query, recall, remember, RestartError, rowValues, showMessage, state, text, valueRow } from '../base.js';
import { select } from '../render.js';
import { loadListing } from '../start.js';

// --- New request -----------------------------------------------------------------------------------------

/**
 * The form of an endpoint: a new one, or, with `edit` ({ file, name, block, text, form }), an existing one,
 * whose block is replaced when saved (tinyprobe spec 0018).
 */
export function newRequestView(edit = null) {
  const apiFiles = state.model.apis.filter(a => !a.workflow);
  const draft = edit ? { file: edit.file, ...edit.form } : recall(`draft:${state.root}`, {});
  const keep = values => { if (!edit) remember(`draft:${state.root}`, values); };
  const status = h('div', { 'aria-live': 'polite' });

  const fileSelect = control('select', { id: 'new-file', disabled: Boolean(edit) },
    apiFiles.map(a => h('option', { value: a.path, selected: draft.file === a.path }, a.path)),
    h('option', { value: '', selected: apiFiles.length === 0 || draft.file === '' }, 'A new API file…'));
  const newName = control('input', { id: 'new-api-name', class: 'input', placeholder: 'shop', value: draft.apiName ?? '' });
  const baseUrl = control('input', { id: 'new-base-url', class: 'input mono', placeholder: 'https://api.example.com or ${baseUrl}', value: draft.baseUrl ?? '' });
  // Renaming would break the workflows that call it: an endpoint keeps its name here.
  const name = control('input', { id: 'new-name', class: 'input mono', placeholder: 'get_user', value: draft.name ?? '', autocomplete: 'off', spellcheck: 'false', readonly: Boolean(edit) });
  const method = control('select', { id: 'new-method' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => h('option', { value: m, selected: (draft.method ?? 'GET') === m }, m)));
  const path = control('input', { id: 'new-path', class: 'input mono', placeholder: '/users/${id}', value: draft.path ?? '', spellcheck: 'false' });
  const auth = control('select', { id: 'new-auth' }, h('option', { value: '' }, 'None'));
  const queryNames = control('input', { id: 'new-query', class: 'input mono', placeholder: 'page, search', value: draft.query ?? '', spellcheck: 'false' });
  const body = control('textarea', { id: 'new-body', placeholder: '{ "title": "${title}" }', spellcheck: 'false' });
  body.value = draft.body ?? '';
  const headerRows = h('div', { class: 'rows' });
  const defaultRows = h('div', { class: 'rows' });

  const addHeader = (header = { name: '', value: '' }) => {
    const row = h('div', { class: 'row' },
      h('input', { class: 'input mono', placeholder: 'X-Client', value: header.name, 'aria-label': 'Header name', oninput: changed }),
      h('input', { class: 'input mono', placeholder: 'tinyprobe', value: header.value, 'aria-label': 'Header value', oninput: changed }),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this header', onclick: () => { row.remove(); changed(); } }, '✕'));
    headerRows.append(row);
  };
  (draft.headers ?? []).forEach(addHeader);

  let fileText = null;
  let existingNames = [];
  async function fileChanged() {
    const chosen = fileSelect.value;
    for (const node of form.querySelectorAll('.new-file')) node.hidden = chosen !== '';
    fileText = null;
    existingNames = [];
    auth.replaceChildren(h('option', { value: '' }, 'None'));
    if (chosen) {
      fileText = edit ? edit.text : await text(`/api/file?${query({ root: state.root, path: chosen })}`).catch(() => null);
      existingNames = (apiFiles.find(a => a.path === chosen)?.endpoints.map(e => e.name) ?? []).filter(n => n !== edit?.name);
      for (const set of core.childKeys(fileText ?? '', 'auth')) auth.append(h('option', { value: set, selected: draft.auth === set }, set));
    }
  }

  function collect() {
    return {
      file: fileSelect.value,
      apiName: newName.value.trim(),
      baseUrl: baseUrl.value.trim(),
      name: name.value.trim(),
      method: method.value,
      path: path.value.trim(),
      auth: auth.value,
      query: queryNames.value,
      body: body.value,
      headers: [...headerRows.children].map(row => ({ name: row.children[0].value.trim(), value: row.children[1].value })).filter(h => h.name || h.value),
      defaults: rowValues(defaultRows)
    };
  }

  function changed() {
    const values = collect();
    keep(values);
    // The values a call can pass: every ${name} written in the request. A default makes it optional.
    const found = core.placeholders(values.path, values.body, ...values.headers.map(x => x.value), ...values.query.split(',').map(x => x.trim() ? `\${${x.trim()}}` : ''));
    const current = new Map(rowValues(defaultRows).map(row => [row.name, row.value]));
    const remembered = new Map((draft.defaults ?? []).map(d => [d.name, d.value]));
    if (found.length === 0) {
      defaultRows.replaceChildren(h('div', { class: 'aside' }, 'Each ${name} of the path, the query and the body appears here, to give it a default.'));
      return;
    }
    defaultRows.replaceChildren(...found.map(argument => {
      return valueRow('default', argument, { placeholder: 'no default: from the call or the environment', value: current.get(argument) ?? remembered.get(argument) ?? '', oninput: () => keep(collect()) });
    }));
  }

  for (const input of [newName, baseUrl, name, path, queryNames, body]) input.addEventListener('input', changed);
  for (const input of [method, auth]) input.addEventListener('change', changed);
  fileSelect.addEventListener('change', () => { fileChanged(); changed(); });

  const save = h('button', { type: 'submit', class: 'button primary' }, 'Save');
  const form = h('form', { onsubmit: async event => {
    event.preventDefault();
    const values = collect();
    status.replaceChildren();
    const problem = core.checkName(values.name, existingNames);
    if (problem) return status.append(h('div', { class: 'notice' }, problem));
    if (!values.path.startsWith('/') && !values.path.startsWith('${')) return status.append(h('div', { class: 'notice' }, 'The path starts with /, e.g. /users/${id}'));

    const request = {
      name: values.name, method: values.method, path: values.path, auth: values.auth,
      query: values.query.split(','), headers: values.headers, body: values.body,
      // Only the placeholders given a default become params: the others stay free, filled by the call or the environment.
      defaults: values.defaults.filter(d => d.value !== '')
    };
    let target = values.file;
    let result;
    if (edit) {
      try {
        result = { text: editing.replaceBlock(fileText, edit.block, core.endpointYaml(request, editing.indentOf(edit.block))) };
      } catch (e) {
        result = { error: e.message };
      }
    } else if (target) {
      result = core.addEndpoint(fileText ?? '', request);
    } else {
      target = core.apiFileName(values.apiName);
      if (!target) return status.append(h('div', { class: 'notice' }, 'Give the new API file a name, e.g. shop'));
      if (state.listing.files.some(f => f.path === target)) return status.append(h('div', { class: 'notice' }, `${target} already exists: pick it in the list.`));
      result = core.newApiFile(values.baseUrl, request);
    }
    if (result.error) return status.append(h('div', { class: 'notice' }, result.error));

    save.disabled = true;
    try {
      const answer = await api('/api/save', { root: state.root, path: target, text: result.text, basis: values.file ? fileText : null });
      if (!answer.saved) {
        status.append(h('div', { class: 'notice' },
          h('strong', null, 'Not saved: tinyprobe does not accept the file with this request. The file is as it was.'),
          h('ul', null, (answer.inspect?.errors ?? []).map(e => h('li', null, e.text)))));
        return;
      }
      if (!edit) remember(`draft:${state.root}`, {});
      await loadListing();
      select({ kind: 'endpoint', file: target, name: values.name });
      showMessage(`Saved ${values.name} in ${target}.`, 'info');
    } catch (e) {
      if (e instanceof RestartError) return;
      if (e.status === 409 && edit) {
        status.append(h('div', { class: 'notice' }, 'The file changed on disk since it was read: open the endpoint again to edit what is there now.'));
      } else if (e.status === 409) {
        await fileChanged();
        status.append(h('div', { class: 'notice' }, 'The file changed on disk since it was read: it is read again now. Save again.'));
      } else {
        status.append(h('div', { class: 'notice' }, e.message));
      }
    } finally {
      save.disabled = false;
    }
  } },
    h('div', { class: 'form' },
      h('label', { for: 'new-file' }, 'API file'), fileSelect,
      h('label', { for: 'new-api-name', class: 'new-file' }, 'New file'), h('div', { class: 'field new-file' }, newName, h('span', { class: 'default' }, 'in api/')),
      h('label', { for: 'new-base-url', class: 'new-file' }, 'Base URL'), h('div', { class: 'field new-file' }, baseUrl),
      h('label', { for: 'new-name' }, 'Name'), name,
      h('label', { for: 'new-method' }, 'Method'), method,
      h('label', { for: 'new-path' }, 'Path'), path,
      h('div', { class: 'hint' }, 'Write ${name} where a value goes: /users/${id}. Each one becomes a value to fill in when you send it.'),
      h('label', { for: 'new-auth' }, 'Auth'), auth,
      h('label', { for: 'new-query' }, 'Query'), queryNames,
      h('div', { class: 'hint' }, 'Names of query parameters, separated by commas; each is sent only when it has a value.'),
      h('label', null, 'Headers'), h('div', null, headerRows, h('button', { type: 'button', class: 'button small', onclick: () => { addHeader(); } }, '+ Header')),
      h('label', { for: 'new-body' }, 'JSON body'), body,
      h('label', null, 'Defaults'), defaultRows),
    h('div', { class: 'actions' }, save,
      edit ? h('button', { type: 'button', class: 'button', onclick: () => select({ kind: 'endpoint', file: edit.file, name: edit.name }) }, 'Cancel') : null,
      h('span', { class: 'aside' }, edit ? 'Only this endpoint is rewritten; tinyprobe checks the file before it is kept.' : 'The request is added to the YAML file, which tinyprobe checks before it is kept.')),
    status);

  queueMicrotask(async () => {
    await fileChanged();
    changed();
  });

  return h('div', null,
    h('h1', null, edit ? `Edit ${edit.name}` : 'New request'),
    h('p', { class: 'lead' }, edit ? edit.file : 'An endpoint of an API file: a request you can send from here, call from a workflow and run in CI.'),
    edit?.comments ? h('div', { class: 'notice info' }, 'The comments inside this endpoint are not kept when it is saved from the form; those around it are. Use Edit as YAML to keep them.') : null,
    form);
}
