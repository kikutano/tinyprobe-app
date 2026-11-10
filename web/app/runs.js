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

// ▶ Up to here continues from where the last run stopped (tinyprobe `run --resume`, spec 0022). The state of
// that run holds tokens, so it is kept only here, in the page's memory, never in the browser's storage: closing
// or reloading the page forgets it, and the next ▶ Up to here runs from the start.
const resumable = new Map();

/** The last run of a workflow up to a step, or null; what it ran with decides whether the next one continues it. */
function lastRun(workflow) {
  return resumable.get(`${state.root}\n${workflow.path}`) ?? null;
}

/**
 * Whether ▶ Up to here on step `to` (1-based) continues the last run, and why not: null when it continues.
 * It continues only a run that stopped at an earlier step with every step passed, with the same environment
 * and the same ⊘ Skip switches. tinyprobe then checks that the steps it ran did not change.
 */
function whyFromTheStart(last, to, switches) {
  if (!last) return '';
  if (!last.state) return 'The last run did not pass: running from the start.';
  if (to <= last.to) return `Step ${to} is not after step ${last.to}, where the last run stopped: running from the start.`;
  if (last.environment !== state.environment) return 'The environment changed: running from the start.';
  if (last.switches !== JSON.stringify(switches)) return 'The ⊘ Skip switches changed: running from the start.';
  return null;
}

/**
 * Runs a workflow, or (with `to`, 1-based) up to a step: ▶ Up to here. `fromStart` runs the steps before it again
 * even when the last run could be continued (↺ From the start).
 */
export async function runWorkflow(workflow, to, { fromStart = false, note = '' } = {}) {
  const switches = skippedSteps(workflow);
  const key = `${state.root}\n${workflow.path}`;
  const last = lastRun(workflow);
  const why = to && state.info.resuming && !fromStart ? whyFromTheStart(last, to, switches) : note;
  // ▶ Up to here on a step turned off runs it: it is the step asked for, and so was the last run's. Continuing,
  // the switches before it are passed too: tinyprobe names those steps when a value they save is missing.
  const skip = switches.filter(index => index !== (to ?? 0) - 1 && index !== (why === null ? last.to - 1 : -1)).map(index => index + 1);
  resumable.delete(key);

  const title = !to ? workflow.name : why === null ? `${workflow.name}, steps ${last.to + 1} to ${to}` : `${workflow.name}, up to step ${to}`;
  const { node, body, signal } = panel(title);
  if (to && state.info.resuming) {
    node.querySelector('.panel-head .when').before(h('button', {
      type: 'button', class: 'button small', title: 'Runs the steps before this one again, from the first step',
      onclick: () => { node.remove(); runWorkflow(workflow, to, { fromStart: true }); }
    }, '↺ From the start'));
  }
  if (why) body.before(h('p', { class: 'run-note' }, why));
  const view = runView.create(body);
  view.reset(workflow.name, state.environment);
  state.runViews.set(workflow.path, { view, node });
  let events = 0;
  // A continued run is shown after the run it continues: its steps keep their results, dimmed.
  const recorded = why === null ? last.events.filter(e => e.event !== 'run_finished') : [];
  for (const event of recorded) view.apply(event);
  state.runs.set(workflow.path, recorded);
  const environment = state.environment;
  try {
    const payload = { root: state.root, files: [workflow.path], to: to ?? null, skip, env: environment };
    if (why === null) payload.resume = last.state;
    let exit = await stream('/api/run', payload, event => {
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
      if (event.event === 'run_finished' && to) {
        resumable.set(key, { to, environment, switches: JSON.stringify(switches), state: event.state ?? null, events: [...recorded] });
      }
      if (event.event === 'run_finished' && !to) {
        recordOutcome(workflow.path, event);
        renderSidebar();
      }
    }, signal);
    // tinyprobe refuses a state whose steps changed since: the run starts again from the first step, and says why.
    if (why === null && events === 0 && exit?.code === 2 && /--resume: the steps up to step \d+ changed/.test(exit.stderr ?? '')) {
      node.remove();
      return runWorkflow(workflow, to, { fromStart: true, note: 'Steps that ran in the last run changed: running from the start.' });
    }
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
