// The history of the calls sent from here.
import { $, api, baseName, h, HISTORY_SIZE, runView, showMessage, state } from '../base.js';
import { render } from '../render.js';
import { callEndpoint, panel } from '../runs.js';

// --- History -----------------------------------------------------------------------------------------------

export function historyView() {
  const entries = state.history;
  const timeOf = entry => new Date(entry.time).toLocaleString();
  const argsOf = entry => (entry.args ?? []).map(([k, v]) => `${k}=${v}`).join(' ');
  const findEndpoint = entry => state.model.apis.find(a => a.path === entry.file)?.endpoints.find(e => e.name === entry.endpoint) ?? null;

  function show(entry) {
    const { body } = panel(`${entry.method ?? ''} ${entry.endpoint}${argsOf(entry) ? `  ${argsOf(entry)}` : ''} · ${timeOf(entry)}`);
    const view = runView.create(body);
    view.reset(entry.endpoint, entry.environment, { call: true });
    for (const event of entry.events ?? []) view.apply(event);
  }

  function again(entry) {
    const endpoint = findEndpoint(entry);
    if (!endpoint) return showMessage(`${entry.endpoint} is no longer in ${entry.file}.`);
    callEndpoint(entry.file, endpoint, Object.fromEntries(entry.args ?? []));
  }

  return h('div', null,
    h('h1', null, 'History'),
    h('p', { class: 'lead' }, `The last ${HISTORY_SIZE} requests sent from here, newest first. Click one to see its request and response again, or send it again with its values and the environment picked now.`),
    entries.length === 0
      ? h('p', { class: 'aside' }, 'Nothing yet: the requests you send from an endpoint appear here.')
      : h('ol', { class: 'step-table' }, entries.map(entry => h('li', null,
        h('span', { class: `verb verb-${entry.method}` }, entry.method ?? ''),
        h('span', { class: 'step-label' },
          h('button', { type: 'button', class: 'link', onclick: () => show(entry), title: 'Show the request and the response' }, entry.endpoint),
          argsOf(entry) ? h('span', { class: 'step-kind' }, `  ${argsOf(entry)}`) : null,
          h('div', { class: 'step-kind' }, `${timeOf(entry)} · ${entry.file}${entry.environment ? ` · ${baseName(entry.environment)}` : ''}`)),
        h('span', { class: `code ${runView.statusClass(entry.status)}` }, entry.status ?? '---'),
        h('span', { class: 'step-kind' }, runView.formatDuration(entry.duration_ms)),
        h('button', { type: 'button', class: 'button small', onclick: () => again(entry), disabled: !findEndpoint(entry) }, 'Send again')))),
    entries.length > 0 ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button small', onclick: async () => {
      if (!confirm('Clear the history of this folder? Its requests and responses are deleted.')) return;
      state.history = [];
      await api('/api/history', { root: state.root, entries: [] }).catch(() => {});
      render();
    } }, 'Clear history')) : null,
    h('p', { class: 'aside' }, "The history is kept in the app's own folder on this computer, not in your project: requests and responses carry credentials. Bodies are cut at 64 KiB."));
}
