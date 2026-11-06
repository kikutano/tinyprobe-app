// A workflow and a sequence: the head, Run, the diagram and the list of steps.
import { saveFile } from './editor.js';
import { $, api, baseName, control, editing, flows, h, query, recall, remember, RestartError, runView, showMessage, slash, state, text } from '../base.js';
import { item, renderView, select } from '../render.js';
import { runWorkflow } from '../runs.js';
import { model } from '../start.js';
import { stepActions, stepsEditor } from './steps.js';

// --- A workflow and a sequence ---------------------------------------------------------------------------

/** The name, the file and the description of a workflow or a sequence, each in its own place so they read apart. */
export function pageHead(title, file, description) {
  return h('header', { class: 'page-head' },
    h('h1', null, title),
    h('span', { class: 'file-chip', title: 'The file in the opened folder' }, file),
    description ? h('p', { class: 'page-desc' }, description) : null);
}

/**
 * Duplicate: a copy of the workflow under a new name, next to it, so its imports and uses stay right. Only the name
 * changes in the file; the copy opens, ready to be changed.
 */
function duplicateForm(workflow) {
  const name = control('input', { id: 'duplicate-name', class: 'input', value: `${workflow.name} (copy)` });
  const status = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'button primary small' }, 'Duplicate');
  const node = h('form', { class: 'head-form duplicate', hidden: true, onsubmit: async event => {
    event.preventDefault();
    status.replaceChildren();
    const target = editing.copyFileName(workflow.path, name.value);
    if (!target) return status.append(h('div', { class: 'notice' }, 'Give the copy a name, e.g. Users for admins.'));
    if (state.listing.files.some(f => f.path === target)) return status.append(h('div', { class: 'notice' }, `${target} already exists: choose another name.`));
    save.disabled = true;
    try {
      const original = await text(`/api/file?${query({ root: state.root, path: workflow.path })}`);
      if (await saveFile(target, editing.renamedWorkflow(original, name.value), null, status)) {
        showMessage(`Created ${target}, a copy of ${workflow.path}.`, 'info');
        select({ kind: 'workflow', file: target });
      }
    } catch (e) {
      if (!(e instanceof RestartError)) status.append(h('div', { class: 'notice' }, e.message));
    } finally {
      save.disabled = false;
    }
  } },
    h('label', { for: 'duplicate-name' }, 'Name of the copy'), name, save,
    h('button', { type: 'button', class: 'button small', onclick: () => { node.hidden = true; } }, 'Cancel'),
    h('div', { class: 'head-form-note duplicate-file' }, ''),
    status);
  const file = node.querySelector('.duplicate-file');
  const showFile = () => { const target = editing.copyFileName(workflow.path, name.value); file.textContent = target ? `File: ${target}` : ''; };
  name.addEventListener('input', showFile);
  showFile();
  return {
    node,
    toggle() {
      node.hidden = !node.hidden;
      if (!node.hidden) { name.focus(); name.select(); }
    }
  };
}

/**
 * Rename: the workflow's name and description, changed where they are written. The file keeps its name, so the
 * history and the last runs, kept by file, stay with it.
 */
function renameForm(workflow) {
  const name = control('input', { id: 'rename-name', class: 'input', value: workflow.name });
  const description = control('input', { id: 'rename-description', class: 'input', value: workflow.inspect.description ?? '', placeholder: 'What it checks (optional)' });
  const status = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'button primary small' }, 'Save');
  const node = h('form', { class: 'head-form rename', hidden: true, onsubmit: async event => {
    event.preventDefault();
    status.replaceChildren();
    if (name.value.trim() === '') return status.append(h('div', { class: 'notice' }, 'A workflow needs a name.'));
    save.disabled = true;
    try {
      const source = await api(`/api/source?${query({ root: state.root, path: workflow.path })}`);
      const next = editing.workflowHead(source.text, source.inspect?.blocks ?? [], { name: name.value, description: description.value });
      if (next === source.text) { node.hidden = true; return; }
      if (await saveFile(workflow.path, next, source.text, status)) {
        showMessage(`Saved the name and the description of ${workflow.path}.`, 'info');
        renderView();
      }
    } catch (e) {
      if (!(e instanceof RestartError)) status.append(h('div', { class: 'notice' }, e.message));
    } finally {
      save.disabled = false;
    }
  } },
    h('label', { for: 'rename-name' }, 'Name'), name,
    h('label', { for: 'rename-description' }, 'Description'), description,
    h('span', { class: 'head-form-actions' }, save, h('button', { type: 'button', class: 'button small', onclick: () => { node.hidden = true; } }, 'Cancel')),
    h('div', { class: 'head-form-note' }, `In ${workflow.path}, which keeps its name.`),
    status);
  return {
    node,
    toggle() {
      node.hidden = !node.hidden;
      if (!node.hidden) { name.focus(); name.select(); }
    }
  };
}

let duplicate = null;
let rename = null;

export function workflowView({ file }) {
  const workflow = state.model.workflows.find(w => w.path === file);
  if (!workflow) return null;
  const steps = workflow.inspect.steps ?? [];
  const mode = recall('workflow-view', 'diagram');
  const toggle = next => { remember('workflow-view', next); renderView(); };

  let content;
  if (mode === 'edit' && state.info.editing) {
    state.flow = null;
    content = stepsEditor(workflow);
  } else if (mode === 'diagram') {
    const model = flows.flowModel(workflow.inspect, state.variables);
    const details = h('div', { class: 'flow-details', 'aria-live': 'polite' });
    const picture = h('div', { class: 'flow' });
    const diagram = flows.createFlow(picture, model, {
      onSelect: at => showStep(workflow, steps[at], diagram, details),
      onRunTo: at => runWorkflow(workflow, model.nodes[at].index + 1)
    });
    for (const event of state.runs.get(workflow.path) ?? []) diagram.apply(event);
    state.flow = { path: workflow.path, diagram };
    const inputs = model.inputs;
    content = h('div', null,
      inputs.environment.length + inputs.variables.length + inputs.other.length > 0 ? h('div', { class: 'flow-inputs' },
        inputs.environment.length ? h('span', null, 'From the environment: ', inputs.environment.flatMap((n, i) => [h('code', null, n), i < inputs.environment.length - 1 ? ', ' : ''])) : null,
        inputs.variables.length ? h('span', null, "From the workflow's variables: ", inputs.variables.flatMap((n, i) => [h('code', null, n), i < inputs.variables.length - 1 ? ', ' : ''])) : null,
        inputs.other.length ? h('span', { class: 'error-text' }, 'Defined nowhere: ', inputs.other.flatMap((n, i) => [h('code', null, n), i < inputs.other.length - 1 ? ', ' : ''])) : null) : null,
      picture,
      details,
      h('p', { class: 'aside' }, 'Each colored line is a value a step saves, down to the steps that use it. Click a step to see what it sends and checks; ▶ Up to here runs the steps before it again and stops at it.'));
  } else {
    state.flow = null;
    // Each step with how it went in the last run, as the diagram shows it; a click goes to its detail.
    const states = stepStates(state.runs.get(workflow.path));
    const icons = { pending: '○', running: '●', passed: '✓', failed: '✗', skipped: '–' };
    content = h('ol', { class: 'step-table' }, steps.map(step => {
      const run = states.get(step.index);
      const result = run?.result;
      return h('li', { class: `step-row${result ? ' has-result' : ''}`, onclick: event => {
        if (event.target.closest('button') || !result) return;
        const last = state.runViews.get(workflow.path);
        if (!last?.node.isConnected) return;
        last.view.select(step.index);
        requestAnimationFrame(() => (last.node.querySelector('.details') ?? last.node).scrollIntoView({ behavior: 'smooth', block: 'start' }));
      } },
      h('span', { class: `step-state ${run?.status ?? ''}`, title: run?.status ?? 'not run yet' }, run ? icons[run.status] : ''),
      h('span', { class: 'step-number' }, step.index + 1),
      h('span', { class: 'step-label' }, step.name,
        step.sequence ? h('span', { class: 'step-kind' }, `  · from ${step.sequence.name || baseName(step.sequence.file)}`) : null,
        step.for_each ? h('span', { class: 'step-kind' }, '  · for each item') : null,
        step.until ? h('span', { class: 'step-kind' }, '  · until') : null),
      step.type === 'call' ? h('span', { class: 'verb' }, step.call ?? '') : h('span', { class: 'step-kind' }, step.type),
      h('span', { class: 'step-result' },
        result ? h('span', { class: `code ${runView.statusClass(result.status)}` }, result.status ?? '---') : null,
        result ? ` ${runView.formatDuration(result.duration_ms)}` : run?.status === 'running' && run.items ? `item ${run.item}/${run.items}` : run?.status === 'running' && run.attempt > 1 ? `attempt ${run.attempt}` : ''),
      editStepButton(workflow, step),
      h('button', { type: 'button', class: 'button small', title: 'Runs the steps before this one again, stops here and shows its response', onclick: () => runWorkflow(workflow, step.index + 1) }, '▶ Up to here'));
    }));
  }

  return h('div', null,
    pageHead(workflow.name, file, workflow.inspect.description),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'button primary', onclick: () => runWorkflow(workflow) }, '▶ Run'),
      outcomeBadge(workflow.path),
      h('span', { class: 'spacer' }),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show the steps as' },
        h('button', { type: 'button', class: `button small${mode === 'diagram' ? ' active' : ''}`, 'aria-pressed': String(mode === 'diagram'), onclick: () => toggle('diagram') }, 'Diagram'),
        h('button', { type: 'button', class: `button small${mode === 'list' ? ' active' : ''}`, 'aria-pressed': String(mode === 'list'), onclick: () => toggle('list') }, 'List'),
        state.info.editing ? h('button', { type: 'button', class: `button small${mode === 'edit' ? ' active' : ''}`, 'aria-pressed': String(mode === 'edit'), onclick: () => toggle('edit') }, 'Edit') : null),
      state.info.editing ? h('button', { type: 'button', class: 'button small', title: 'Change the name and the description', onclick: () => { duplicate.node.hidden = true; rename.toggle(); } }, '✎ Rename') : null,
      state.info.editing ? h('button', { type: 'button', class: 'button small', title: 'A copy of this workflow, to change what differs', onclick: () => { rename.node.hidden = true; duplicate.toggle(); } }, '⧉ Duplicate') : null),
    state.info.editing ? (rename = renameForm(workflow)).node : null,
    state.info.editing ? (duplicate = duplicateForm(workflow)).node : null,
    content,
    mode === 'list' ? h('p', { class: 'aside' }, '▶ Up to here runs the steps before a step again each time, and stops at it: nothing is kept between runs.') : null);
}

/**
 * The last run of a workflow at a glance, next to Run: "✓ 12/12 passed", "✗ 11/12 passed · 1 failed", or how far
 * a run is while it goes. Counts are tinyprobe's: each item of a for_each is a step.
 */
export function outcomeBadge(path) {
  const node = h('span', { class: 'run-outcome', id: 'run-outcome', 'data-path': path, 'aria-live': 'polite' });
  fillOutcome(node, path);
  return node;
}

export function fillOutcome(node, path) {
  const events = state.runs.get(path) ?? [];
  const started = events.find(e => e.event === 'run_started');
  const finished = events.find(e => e.event === 'run_finished');
  node.className = 'run-outcome';
  node.hidden = !started;
  if (!started) return node.replaceChildren();
  const upTo = started.to !== null && started.to !== undefined ? ` up to step ${started.to + 1}` : '';
  if (!finished) {
    const done = events.filter(e => e.event === 'step_completed').length;
    node.classList.add('running');
    node.title = 'Running';
    return node.replaceChildren(`● ${done}/${(started.steps ?? []).length}${upTo}`);
  }
  const s = finished.summary;
  const parts = [`${s.passed_steps}/${s.total_steps} passed`, s.failed_steps ? `${s.failed_steps} failed` : null, s.not_run_steps ? `${s.not_run_steps} not run` : null].filter(Boolean);
  node.classList.add(finished.success ? 'passed' : 'failed');
  node.title = `Last run${upTo}: ${runView.formatDuration(s.duration_ms)}, ${s.checks_passed + s.checks_failed} checks, ${s.http_requests} requests`;
  node.replaceChildren(`${finished.success ? '✓' : '✗'} ${parts.join(' · ')}${upTo}`);
}

/** How each step went in a run, from its events: the same states as the diagram. */
export function stepStates(events) {
  const states = new Map();
  for (const e of events ?? []) {
    if (e.event === 'run_started') {
      states.clear();
      for (const s of e.steps ?? []) states.set(s.index, { status: 'pending' });
    } else if (e.event === 'step_started') {
      // A step that starts ends the sleep before it, which has no step_completed.
      for (const [index, s] of states) if (index < e.index && s.status === 'running') s.status = 'passed';
      states.set(e.index, { status: 'running', attempt: e.attempt ?? 1, item: e.iteration ?? null, items: e.iterations ?? null });
    } else if (e.event === 'step_completed') {
      states.set(e.index, { status: e.success ? 'passed' : 'failed', result: e });
    } else if (e.event === 'run_finished') {
      for (const s of states.values()) {
        if (s.status === 'running') s.status = 'passed';
        else if (s.status === 'pending') s.status = 'skipped';
      }
    }
  }
  return states;
}

/** Edit for a step of `inspect`: its form, found by its line; a step from a sequence opens its use step. */
export function editStepButton(workflow, step) {
  const line = step.location?.line;
  if (!state.info.editing || !line || slash(step.location.file) !== workflow.path && !slash(step.location.file).endsWith(`/${workflow.path}`)) return null;
  return h('button', {
    type: 'button', class: 'button small',
    title: step.sequence ? 'Edit the use step that runs this sequence' : 'Edit this step',
    onclick: () => select({ kind: 'edit-step', file: workflow.path, line })
  }, 'Edit');
}

/** What a step of the diagram sends, checks and saves, with its result in the last run. */
export function showStep(workflow, step, diagram, details) {
  if (!step) return details.replaceChildren();
  // After a run, the step's request and response; before, what it sends and checks.
  const last = state.runViews.get(workflow.path);
  const ran = last && last.node.isConnected && diagram.state(diagram.selected)?.result;
  const result = diagram.state(diagram.selected)?.result;
  const checks = [...(step.expect?.checks ?? [])];
  const withValues = Object.entries(step.with ?? {});
  const saves = Object.entries(step.save ?? {});
  details.replaceChildren(h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('span', { class: 'what' }, `${step.index + 1}. ${step.name}`),
      h('span', { class: 'panel-actions' },
        editStepButton(workflow, step),
        ...stepActions(workflow, step),
        h('button', { type: 'button', class: 'button small', title: 'Runs the steps before this one again, stops here and shows its response', onclick: () => runWorkflow(workflow, step.index + 1) }, '▶ Up to here'))),
    h('div', { class: 'panel-body' },
      step.type === 'call' ? h('div', { class: 'mono' }, `call ${step.call}`) : h('div', { class: 'mono' }, step.type),
      step.sequence ? h('div', { class: 'aside' }, `From the sequence ${step.sequence.name || baseName(step.sequence.file)}.`) : null,
      withValues.length ? h('div', null, h('h2', null, 'Sends'), h('ul', { class: 'plain' }, withValues.map(([k, v]) => h('li', { class: 'mono' }, `${k}: ${JSON.stringify(v)}`)))) : null,
      step.expect && (step.expect.status?.length || checks.length) ? h('div', null, h('h2', null, 'Checks'),
        h('ul', { class: 'plain' },
          step.expect.status?.length ? h('li', { class: 'mono' }, `status ${step.expect.status.join(' or ')}`) : null,
          checks.map(c => h('li', { class: 'mono' }, `${c.subject} ${c.condition}`)))) : null,
      step.until ? h('div', { class: 'aside' }, `Repeated every ${step.until.every_ms} ms, up to ${step.until.timeout_ms} ms, until its checks pass.`) : null,
      step.for_each ? h('div', { class: 'aside' }, 'Called once per item of its for_each.') : null,
      saves.length ? h('div', null, h('h2', null, 'Saves'), h('ul', { class: 'plain' }, saves.map(([k, v]) => h('li', { class: 'mono' }, `${k} ← ${v}`)))) : null,
      result ? h('div', null, h('h2', null, 'Last run'),
        h('div', { class: result.success ? '' : 'error-text' }, `${result.success ? 'Passed' : 'Failed'} · status ${result.status ?? 'none'} · ${runView.formatDuration(result.duration_ms)}${result.failure ? ` · ${result.failure}` : ''}`),
        h('div', { class: 'aside' }, 'Its request and response are in the result below.')) : null)));
  // Selecting re-renders the result, so its detail is looked up after.
  if (ran) last.view.select(step.index);
  requestAnimationFrame(() => (ran ? last.node.querySelector('.details') ?? last.node : details).scrollIntoView({ behavior: 'smooth', block: 'start' }));
}


export function sequenceView({ file }) {
  const sequence = state.model.sequences.find(s => s.path === file);
  if (!sequence) return null;
  const params = sequence.inspect.params ?? [];
  return h('div', null,
    pageHead(sequence.name, file, 'A sequence runs inside workflows, through a use: step, with the values given in its with:. Run a workflow that uses it to see it work.'),
    params.length > 0 ? h('h2', null, 'Params') : null,
    params.length > 0 ? h('div', { class: 'form' }, params.flatMap(p => [h('label', null, p.name, p.required ? h('span', { class: 'required' }, '*') : null), h('div', { class: 'aside' }, p.required ? 'required' : `default ${JSON.stringify(p.default)}`)])) : null,
    h('ol', { class: 'step-table' }, (sequence.inspect.steps ?? []).map(step => h('li', null,
      h('span', { class: 'step-number' }, step.index + 1),
      h('span', { class: 'step-label' }, step.name),
      h('span', { class: 'step-kind' }, step.type)))));
}
