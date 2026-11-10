// An endpoint: its form, sent with tinyprobe call.
import { api, baseName, h, recall, remember, showMessage, state } from '../base.js';
import { select } from '../render.js';
import { callEndpoint } from '../runs.js';
import { deleteBlock } from './editor.js';

// --- An endpoint -----------------------------------------------------------------------------------------

export function endpointView({ file, name }) {
  const api = state.model.apis.find(a => a.path === file);
  const endpoint = api?.endpoints.find(e => e.name === name);
  if (!endpoint) return null;

  const key = `args:${state.root}:${file}:${name}`;
  const saved = recall(key, {});
  const params = [...endpoint.params].sort((a, b) => Number(b.required) - Number(a.required));
  const named = new Set(params.map(p => p.name));
  const queryNames = (endpoint.query ?? []).filter(n => n && !named.has(n));
  queryNames.forEach(n => named.add(n));
  // What the environment defines (baseUrl, token) is folded away; what it does not is a value to fill in.
  const fromEnvironment = new Set(state.variables);
  const rest = (endpoint.arguments ?? []).filter(n => !named.has(n));
  const free = rest.filter(n => !fromEnvironment.has(n));
  const others = rest.filter(n => fromEnvironment.has(n));

  const inputs = new Map();
  const field = (argument, { required = false, fallback = null, hint = null } = {}) => {
    const id = `arg-${argument}`;
    const input = h('input', { class: 'input mono', id, name: argument, value: saved[argument] ?? '', placeholder: fallback ?? (required ? 'required' : ''), autocomplete: 'off', spellcheck: 'false' });
    inputs.set(argument, { input, required });
    return [
      h('label', { for: id }, argument, required ? h('span', { class: 'required', 'aria-label': 'required' }, '*') : null),
      h('div', { class: 'field' }, input, fallback !== null ? h('span', { class: 'default' }, 'default') : null),
      hint ? h('div', { class: 'hint' }, hint) : null
    ];
  };

  // The values are kept as they are typed, not only when sent: the view is drawn again when the window comes back
  // to the front (the folder may have changed) or when another endpoint is opened and this one again.
  const typed = () => Object.fromEntries([...inputs].filter(([, { input }]) => input.value !== '').map(([argument, { input }]) => [argument, input.value]));
  const send = h('button', { type: 'submit', class: 'button primary' }, '▶ Send');
  const form = h('form', { oninput: () => remember(key, typed()), onsubmit: event => {
    event.preventDefault();
    const values = typed();
    const missing = [];
    for (const [argument, { input, required }] of inputs) {
      input.classList.remove('invalid');
      if (input.value === '' && required) {
        missing.push(argument);
        input.classList.add('invalid');
      }
    }
    remember(key, values);
    if (missing.length > 0) {
      showMessage(`Fill in ${missing.join(', ')}: ${missing.length === 1 ? 'it is' : 'they are'} required.`);
      inputs.get(missing[0]).input.focus();
      return;
    }
    callEndpoint(file, endpoint, values);
  } },
    params.length + queryNames.length + free.length > 0
      ? h('div', { class: 'form' },
        params.flatMap(p => field(p.name, { required: p.required, fallback: p.default === null || p.default === undefined ? null : JSON.stringify(p.default) })),
        free.flatMap(n => field(n, { hint: state.environment ? `not in ${baseName(state.environment)}: fill it in` : 'no environment picked: fill it in, or pick one at the top' })),
        queryNames.flatMap(n => field(n, { hint: 'query parameter, sent only when filled in' })))
      : h('p', { class: 'aside' }, 'Nothing to fill in: send it as it is.'),
    // Open when one of its values was typed, so a value drawn again is not hidden.
    others.length > 0 ? h('details', { class: 'more', open: others.some(n => saved[n] !== undefined && saved[n] !== '') },
      h('summary', null, `From ${baseName(state.environment)}: ${others.join(', ')} (fill in to override)`),
      h('div', { class: 'form' }, others.flatMap(n => field(n)))) : null,
    h('div', { class: 'actions' }, send,
      h('span', { class: 'aside' }, 'Values are read like YAML: 42 is a number, true a boolean, "42" a string.')));

  return h('div', null,
    h('div', { class: 'title-row' }, h('span', { class: `verb verb-${endpoint.method}` }, endpoint.method), h('h1', null, endpoint.name),
      state.info.editing ? h('span', { class: 'spacer' }) : null,
      state.info.editing ? h('div', { class: 'title-actions' },
        h('button', { type: 'button', class: 'button small', onclick: () => select({ kind: 'edit-endpoint', file, name }) }, 'Edit'),
        h('button', { type: 'button', class: 'button small', onclick: () => select({ kind: 'yaml', file, block: { kind: 'endpoint', name }, back: { kind: 'endpoint', file, name } }) }, 'YAML'),
        h('button', { type: 'button', class: 'button small', onclick: () => deleteBlock(file, 'endpoint', name, `the endpoint ${name}`, () => select({ kind: 'home' })) }, 'Delete')) : null),
    h('div', { class: 'where' }, `${file}:${endpoint.location?.line ?? ''}`),
    h('div', { class: 'path' }, `${endpoint.base_url ?? ''}${endpoint.path}`),
    form);
}
