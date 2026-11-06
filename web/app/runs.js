// Calls and runs: the launcher's ndjson streams, shown with the shared run view.
import { $, api, baseName, core, h, HISTORY_SIZE, recall, remember, requestHistory, RestartError, runView, showRestart, slash, state } from './base.js';
import { ownerOf, renderSidebar, renderView, renderViewNow, renderViewSoon, showOwnResults } from './render.js';
import { fillOutcome } from './views/workflow.js';

// --- Calls and runs --------------------------------------------------------------------------------------

/** A result panel; closing it stops the request or the run. */
export function panel(title) {
  const controller = new AbortController();
  const body = h('div', { class: 'panel-body' });
  const owner = ownerOf(state.selection);
  const node = h('article', { class: 'panel', 'data-owner': owner },
    h('div', { class: 'panel-head' },
      h('span', { class: 'what' }, title),
      h('span', { class: 'when' }, new Date().toLocaleTimeString()),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close and stop', title: 'Close (stops it if it is running)', onclick: () => { controller.abort(); node.remove(); } }, '✕')),
    body);
  $('results').prepend(node);
  // At most a few results per view: older ones go, as in a terminal's scrollback.
  const own = [...$('results').children].filter(n => n.dataset.owner === owner);
  for (const old of own.slice(5)) old.remove();
  showOwnResults();
  return { node, body, signal: controller.signal };
}

/** Posts to a streaming route and passes each tinyprobe event on; returns the app's own last line. */
export async function stream(path, payload, onEvent, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  if (response.status === 401) {
    showRestart();
    throw new RestartError('restart');
  }
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    throw new Error(json?.error ?? `The app answered ${response.status}.`);
  }
  let exit = null;
  const lines = new core.LineSplitter(line => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.app === 'exit') exit = event;
    else onEvent(event);
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    lines.push(decoder.decode(value, { stream: true }));
  }
  lines.push(decoder.decode());
  lines.end();
  return exit;
}

export function stopped(view, exit, events) {
  if (exit && exit.code !== 0 && events === 0) {
    view.error(exit.stderr?.trim() || `tinyprobe stopped with exit code ${exit.code}.`);
  }
}

export async function callEndpoint(file, endpoint, values) {
  const shown = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ');
  const { body, signal } = panel(`${endpoint.method} ${endpoint.name}${shown ? `  ${shown}` : ''}`);
  const view = runView.create(body);
  view.reset(endpoint.name, state.environment, { call: true });
  const events = [];
  const root = state.root;
  const environment = state.environment;
  try {
    const exit = await stream('/api/call', {
      root, file, endpoint: endpoint.name, env: environment,
      with: Object.entries(values).map(([name, value]) => ({ name, value }))
    }, event => { events.push(event); view.apply(event); }, signal);
    stopped(view, exit, events.length);
  } catch (e) {
    if (e.name !== 'AbortError' && !(e instanceof RestartError)) view.error(e.message);
  }
  await record(root, { file, endpoint: endpoint.name, args: Object.entries(values), environment, events, time: Date.now() });
}

/** A call that sent a request goes into the folder's history; one stopped by invalid arguments does not. */
export async function record(root, call) {
  const entry = requestHistory.historyEntry(call);
  if (!entry || root !== state.root) return;
  state.history = requestHistory.addToHistory(state.history, entry, HISTORY_SIZE);
  renderSidebar();
  if (state.selection.kind === 'history') renderView();
  await api('/api/history', { root, entries: state.history }).catch(() => {});
}

// --- Steps turned off in runs ----------------------------------------------------------------------------
//
// tinyprobe run --skip (spec 0021): the file does not change, the page keeps the switches per folder and
// workflow, by the step's index and name, until they are turned back on. A step whose name changed at that
// index is no longer turned off: the page never skips a step the user did not choose.

function skipStore() {
  return recall(`skips:${state.root}`, {});
}

/** The indexes of the steps of a workflow turned off in its runs; none when tinyprobe cannot skip. */
export function skippedSteps(workflow) {
  if (!state.info.skipping) return [];
  const all = skipStore();
  const saved = all[workflow.path] ?? [];
  const steps = workflow.inspect.steps ?? [];
  const kept = saved.filter(s => steps[s.index]?.name === s.name);
  if (kept.length !== saved.length) {
    if (kept.length) all[workflow.path] = kept;
    else delete all[workflow.path];
    remember(`skips:${state.root}`, all);
  }
  return kept.map(s => s.index).sort((a, b) => a - b);
}

/** Turns a step off in runs, or on again; false when it would leave no step to run. */
export function toggleSkip(workflow, step) {
  const all = skipStore();
  const off = new Set(skippedSteps(workflow));
  if (off.has(step.index)) off.delete(step.index);
  else if (off.size + 1 >= (workflow.inspect.steps ?? []).length) return false;
  else off.add(step.index);
  const steps = workflow.inspect.steps ?? [];
  if (off.size) all[workflow.path] = [...off].sort((a, b) => a - b).map(index => ({ index, name: steps[index].name }));
  else delete all[workflow.path];
  remember(`skips:${state.root}`, all);
  return true;
}

/** Every step of a workflow runs again. */
export function clearSkips(workflow) {
  const all = skipStore();
  delete all[workflow.path];
  remember(`skips:${state.root}`, all);
}

export async function runWorkflow(workflow, to) {
  const { node, body, signal } = panel(to ? `${workflow.name}, up to step ${to}` : workflow.name);
  const view = runView.create(body);
  view.reset(workflow.name, state.environment);
  state.runViews.set(workflow.path, { view, node });
  let events = 0;
  const recorded = [];
  state.runs.set(workflow.path, recorded);
  try {
    // ▶ Up to here on a step turned off runs it: it is the step asked for.
    const skip = skippedSteps(workflow).filter(index => !to || index !== to - 1).map(index => index + 1);
    const exit = await stream('/api/run', { root: state.root, files: [workflow.path], to: to ?? null, skip, env: state.environment }, event => {
      events++;
      view.apply(event);
      // The diagram lights up as the run goes, and again when the workflow is opened later.
      recorded.push(event);
      if (state.flow?.path === workflow.path) state.flow.diagram.apply(event);
      // The badge next to Run follows the run, and so does the list view.
      const badge = $('run-outcome');
      if (badge?.dataset.path === workflow.path) fillOutcome(badge, workflow.path);
      if (state.selection.kind === 'workflow' && state.selection.file === workflow.path && recall('workflow-view', 'diagram') === 'list') {
        // The end of the run is shown at once, the events before it together.
        if (event.event === 'run_finished') renderViewNow();
        else renderViewSoon();
      }
      if (event.event === 'run_finished' && !to) {
        recordOutcome(workflow.path, event);
        renderSidebar();
      }
    }, signal);
    stopped(view, exit, events);
  } catch (e) {
    if (e.name !== 'AbortError' && !(e instanceof RestartError)) view.error(e.message);
  }
}

/**
 * The last whole run of a workflow, for the sidebar and the overview: kept per folder in the browser, so it is
 * still there when the app is opened again. A run up to a step (▶ Up to here) is not a whole run.
 */
export function recordOutcome(path, finished) {
  const s = finished.summary ?? {};
  state.outcomes.set(path, {
    success: finished.success,
    passed: s.passed_steps ?? 0,
    total: s.total_steps ?? 0,
    failed: s.failed_steps ?? 0,
    skipped: s.skipped_steps ?? 0,
    duration: s.duration_ms ?? 0,
    at: Date.now(),
    environment: state.environment
  });
  remember(`outcomes:${state.root}`, Object.fromEntries(state.outcomes));
  if (state.selection.kind === 'home') renderView();
}

/** The folder as a suite: one run view per workflow, as they start. */
export async function runAll() {
  const { node, body, signal } = panel(`All workflows of ${baseName(state.root)}`);
  const first = runView.create(body);
  first.reset('All workflows', state.environment);
  let current = null;
  let currentFile = null;
  let events = 0;
  let firstUsed = false;
  const summary = h('div', { class: 'suite-summary', hidden: true });
  node.append(summary);
  try {
    const exit = await stream('/api/run', { root: state.root, files: [], env: state.environment }, event => {
      events++;
      if (event.event === 'run_started') {
        // The first workflow uses the panel's own view; each next one gets a view below it.
        const part = firstUsed ? h('div', { class: 'panel-body' }) : body;
        if (firstUsed) node.insertBefore(part, summary);
        current = firstUsed ? runView.create(part) : first;
        firstUsed = true;
        current.reset(event.workflow, state.environment);
        currentFile = state.model.workflows.find(w => state.root && slash(event.file).endsWith(`/${w.path}`))?.path ?? null;
      }
      if (event.event === 'suite_started' || event.event === 'suite_finished') {
        if (event.event === 'suite_finished') {
          const s = event.summary;
          summary.hidden = false;
          summary.textContent = `${s.passed_workflows}/${s.total_workflows} workflows passed · ${s.passed_steps}/${s.total_steps} steps · ${runView.formatDuration(s.duration_ms)}`;
        }
        return;
      }
      (current ?? first).apply(event);
      if (event.event === 'run_finished' && currentFile) {
        recordOutcome(currentFile, event);
        renderSidebar();
      }
    }, signal);
    stopped(current ?? first, exit, events);
  } catch (e) {
    if (e.name !== 'AbortError' && !(e instanceof RestartError)) (current ?? first).error(e.message);
  }
}
