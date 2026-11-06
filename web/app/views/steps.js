// The steps of a workflow: their form, and a new workflow.
import { $, api, control, editing, h, query, RestartError, rowValues, showMessage, slash, state, valueRow } from '../base.js';
import { renderView, select } from '../render.js';
import { deleteBlock, editorShell, saveFile, yamlOnly } from './editor.js';

// --- Steps of a workflow -------------------------------------------------------------------------------------

export function stepLabel(step) {
  if (step?.name) return step.name;
  if (step?.call) return `call ${step.call}`;
  if (step?.use) return `use ${step.use}`;
  if (step?.sleep !== undefined) return `sleep ${step.sleep}`;
  return 'step';
}

/** The steps as written in the file, `use` steps included, to edit, move, add and delete. */
export function stepsEditor(workflow) {
  return editorShell(null, workflow.path, source => {
    const steps = source.inspect?.source?.steps ?? [];
    const blocks = (source.inspect?.blocks ?? []).filter(b => b.kind === 'step');
    const status = h('div', { 'aria-live': 'polite' });
    const move = async (i, j) => {
      const [a, b] = i < j ? [blocks[i], blocks[j]] : [blocks[j], blocks[i]];
      if (await saveFile(workflow.path, editing.swapBlocks(source.text, a, b), source.text, status)) renderView();
    };
    const back = { kind: 'workflow', file: workflow.path };
    return h('div', null,
      h('ol', { class: 'step-table' }, steps.map((step, i) => h('li', null,
        h('span', { class: 'step-number' }, i + 1),
        h('span', { class: 'step-label' }, stepLabel(step),
          step.call && step.name ? h('span', { class: 'step-kind' }, `  · call ${step.call}`) : null,
          step.for_each ? h('span', { class: 'step-kind' }, '  · for_each') : null,
          step.until ? h('span', { class: 'step-kind' }, '  · until') : null),
        h('button', { type: 'button', class: 'button small', onclick: () => select({ kind: 'edit-step', file: workflow.path, index: i }) }, 'Edit'),
        h('button', { type: 'button', class: 'button small', onclick: () => select({ kind: 'yaml', file: workflow.path, block: { kind: 'step', index: i }, back }) }, 'YAML'),
        h('button', { type: 'button', class: 'icon-button', title: 'Duplicate: a copy right after it', 'aria-label': `Duplicate step ${i + 1}`, onclick: async () => {
          if (await saveFile(workflow.path, editing.duplicateStep(source.text, blocks[i]), source.text, status)) {
            showMessage(`Added a copy of step ${i + 1} after it.`, 'info');
            renderView();
          }
        } }, '⧉'),
        h('button', { type: 'button', class: 'icon-button', title: 'Add a step after this one', 'aria-label': `Add a step after step ${i + 1}`, onclick: () => select({ kind: 'edit-step', file: workflow.path, index: null, afterLine: blocks[i].start.line }) }, '+'),
        h('button', { type: 'button', class: 'icon-button', title: 'Move up', 'aria-label': `Move step ${i + 1} up`, disabled: i === 0, onclick: () => move(i - 1, i) }, '↑'),
        h('button', { type: 'button', class: 'icon-button', title: 'Move down', 'aria-label': `Move step ${i + 1} down`, disabled: i === steps.length - 1, onclick: () => move(i, i + 1) }, '↓'),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': `Delete step ${i + 1}`, disabled: steps.length === 1, title: steps.length === 1 ? 'A workflow needs one step' : 'Delete', onclick: () => deleteBlock(workflow.path, 'step', i, `step ${i + 1} (${stepLabel(step)})`, renderView) }, '✕')))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'button primary', onclick: () => select({ kind: 'edit-step', file: workflow.path, index: null }) }, '+ Add a step')),
      h('p', { class: 'aside' }, 'Steps from a sequence are edited in the sequence file; here a use step is one step.'),
      status);
  });
}

/** The values of a call: the endpoint's params first, then its other arguments, then what the step already gives. */
export function withRows(endpoint, given) {
  const names = [];
  for (const p of endpoint?.params ?? []) if (!names.includes(p.name)) names.push(p.name);
  for (const a of endpoint?.arguments ?? []) if (!names.includes(a) && !state.variables.includes(a)) names.push(a);
  for (const g of given) if (!names.includes(g.name)) names.push(g.name);
  return names.map(n => ({ name: n, value: given.find(g => g.name === n)?.value ?? '', required: (endpoint?.params ?? []).some(p => p.name === n && p.required) }));
}

/**
 * The form of one step: a call with its values, expected status, checks and saves; a sequence run with `use`
 * and its params; or a wait. `sequences` ({ path, name, params }) and `file`, the workflow, offer `use`.
 */
export function stepForm({ endpoints, sequences = [], file = null, initial, onSave, onCancel, onYaml, status }) {
  const offersUse = file !== null && (sequences.length > 0 || initial.kind === 'use');
  const kind = control('select', { id: 'step-kind' },
    h('option', { value: 'call', selected: initial.kind === 'call' || !initial.kind }, 'Call an endpoint'),
    offersUse ? h('option', { value: 'use', selected: initial.kind === 'use' }, 'Run a sequence') : null,
    h('option', { value: 'sleep', selected: initial.kind === 'sleep' }, 'Wait'));
  // The sequence as written in the file, relative to the workflow; one not found keeps its path.
  const written = initial.kind === 'use' ? initial.use : null;
  const known = written !== null && sequences.some(q => q.path === editing.resolvePath(file, written));
  const sequence = control('select', { id: 'step-use' },
    written !== null && !known ? h('option', { value: written, selected: true }, `${written}  (not found)`) : null,
    sequences.map(q => {
      const path = editing.relativePath(file ?? '', q.path);
      return h('option', { value: path, selected: written !== null && editing.resolvePath(file, written) === q.path }, `${q.name}  (${q.path})`);
    }));
  const useArea = h('div', { class: 'rows' });
  let usedGiven = initial.kind === 'use' ? initial.with ?? [] : [];
  const name = control('input', { id: 'step-name', value: initial.name ?? '', placeholder: 'What this step checks, e.g. The user can be read' });
  const call = control('select', { id: 'step-call' }, endpoints.map(e => h('option', { value: e.name, selected: initial.call === e.name }, `${e.name}  (${e.method} ${e.path})`)));
  const sleep = control('input', { id: 'step-sleep', value: initial.sleep ?? '1s', placeholder: '1s, 500ms' });
  const status_ = control('input', { id: 'step-status', value: initial.status ?? '', placeholder: '200, or 200, 204 (any 2xx when empty)' });
  const withArea = h('div', { class: 'rows' });
  const checkRows = h('div', { class: 'rows' });
  const saveRows = h('div', { class: 'rows' });
  const extra = control('textarea', { id: 'step-extra', class: 'textarea', rows: Math.min(Math.max((initial.extra ?? '').split('\n').length + 1, 4), 24), placeholder: 'until:\n  every: 1s\n  timeout: 30s' });
  extra.value = initial.extra ?? '';
  let given = initial.kind === 'use' ? [] : initial.with ?? [];

  const drawWith = () => {
    const endpoint = endpoints.find(e => e.name === call.value);
    given = rowValues(withArea).concat(given.filter(g => !withArea.querySelector(`[data-name="${CSS.escape(g.name)}"]`)));
    withArea.replaceChildren(...withRows(endpoint, given).map(r => valueRow('with', r.name, {
      required: r.required,
      value: r.value,
      placeholder: state.variables.includes(r.name) ? 'from the environment' : r.required ? 'required' : 'empty: a value saved by an earlier step, or not sent'
    })));
  };
  // The params of the sequence: required ones marked, the others with their default as the placeholder.
  const drawUse = () => {
    const picked = sequences.find(q => q.path === editing.resolvePath(file ?? '', sequence.value));
    usedGiven = rowValues(useArea).concat(usedGiven.filter(g => !useArea.querySelector(`[data-name="${CSS.escape(g.name)}"]`)));
    const params = picked?.params ?? [];
    const names = [...params.map(p => p.name), ...usedGiven.map(g => g.name).filter(n => !params.some(p => p.name === n))];
    useArea.replaceChildren(...names.map(n => {
      const param = params.find(p => p.name === n);
      return valueRow('use', n, {
        required: Boolean(param?.required),
        value: usedGiven.find(g => g.name === n)?.value ?? '',
        placeholder: param?.required ? 'required' : param ? `empty: the default, ${JSON.stringify(param.default)}` : 'not a param of this sequence'
      });
    }));
    if (names.length === 0) useArea.append(h('div', { class: 'aside' }, 'This sequence has no params.'));
  };
  sequence.addEventListener('change', drawUse);
  // A check reads the body by a JSONPath, a header or a cookie by its name, or the time of the response.
  const checkHints = {
    body: ['$.id', 'JSONPath of the value', 'value'],
    header: ['Content-Type', 'Name of the header', 'text'],
    cookie: ['sid', 'Name of the cookie', 'text'],
    duration: ['', '', '500ms, 2s']
  };
  const addCheck = (c = { on: 'body', path: '$.', op: 'eq', value: '' }, rows = checkRows, places = editing.CHECK_PLACES) => {
    const on = control('select', { 'aria-label': 'What the check reads' }, places.map(([k, label]) => h('option', { value: k, selected: (c.on ?? 'body') === k }, label)));
    const path = control('input', { value: c.path });
    const op = control('select', { 'aria-label': 'Condition' });
    const value = control('input', { value: c.value, 'aria-label': 'Expected value' });
    const shape = () => {
      const [example, label, expected] = checkHints[on.value];
      const duration = on.value === 'duration';
      path.hidden = duration;
      path.placeholder = example;
      path.setAttribute('aria-label', label);
      value.placeholder = expected;
      // A body path typed as "$." means nothing for a header: start it empty.
      if (on.value !== 'body' && path.value === '$.') path.value = '';
      if (on.value === 'body' && path.value === '') path.value = '$.';
      const keep = op.value || c.op;
      const allowed = editing.OPERATORS.filter(([k]) => !duration || editing.DURATION_OPERATORS.includes(k));
      op.replaceChildren(...allowed.map(([k, label]) => h('option', { value: k, selected: keep === k }, label)));
      row.classList.toggle('duration', duration);
    };
    const row = h('div', { class: 'row check-row' }, on, path, op, value,
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this check', onclick: () => row.remove() }, '✕'));
    on.addEventListener('change', shape);
    shape();
    rows.append(row);
  };
  const readChecks = rows => [...rows.children].map(r => ({ on: r.children[0].value, path: r.children[1].value.trim(), op: r.children[2].value, value: r.children[3].value }))
    .filter(c => c.on === 'duration' ? c.value.trim() !== '' : c.path && c.path !== '$.');

  // for_each: the items as a table (a column per argument), a variable holding a list, or a data file.
  const repeat = control('select', { id: 'step-repeat' },
    [['', 'Once'], ['list', 'For each item of a table'], ['variable', 'For each item of a variable'], ['file', 'For each line of a file']]
      .map(([k, label]) => h('option', { value: k, selected: (initial.forEach?.kind ?? '') === k }, label)));
  const itemsHead = h('tr');
  const itemsBody = h('tbody');
  const itemsTable = h('table', { class: 'items-table' }, h('thead', null, itemsHead), itemsBody);
  const columnCell = name => h('th', null, h('div', { class: 'cell' },
    control('input', { value: name, placeholder: 'argument', 'aria-label': 'Argument of each item' }),
    h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this column', onclick: event => {
      const at = [...itemsHead.children].indexOf(event.target.closest('th'));
      itemsHead.children[at].remove();
      for (const row of itemsBody.children) row.children[at].remove();
    } }, '✕')));
  const valueCell = value => h('td', null, control('input', { value: value ?? '', 'aria-label': 'Value for this item' }));
  const addItem = (item = {}) => {
    const names = [...itemsHead.querySelectorAll('input')].map(i => i.value);
    const row = h('tr', null, names.map(n => valueCell(item[n])),
      h('td', { class: 'row-end' }, h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this item', onclick: () => row.remove() }, '✕')));
    itemsBody.append(row);
  };
  const addColumn = (name = '') => {
    itemsHead.append(columnCell(name));
    for (const row of itemsBody.children) row.insertBefore(valueCell(''), row.lastElementChild);
  };
  const listItems = initial.forEach?.kind === 'list' ? initial.forEach : { columns: [''], items: [{}] };
  listItems.columns.forEach(name => addColumn(name));
  listItems.items.forEach(item => addItem(item));
  const variable = control('input', { id: 'step-each-variable', value: initial.forEach?.kind === 'variable' ? initial.forEach.value : '', placeholder: '${users}' });
  const dataFile = control('input', { id: 'step-each-file', value: initial.forEach?.kind === 'file' ? initial.forEach.file : '', placeholder: '../data/cases.csv' });
  const listArea = h('div', null, itemsTable, h('div', { class: 'actions tight' },
    h('button', { type: 'button', class: 'button small', onclick: () => addItem() }, '+ Item'),
    h('button', { type: 'button', class: 'button small', onclick: () => addColumn() }, '+ Column')));
  const repeatArea = h('div', null, repeat, h('div', { class: 'repeat-detail' }, listArea, variable, dataFile));
  const drawRepeat = () => {
    listArea.hidden = repeat.value !== 'list';
    variable.hidden = repeat.value !== 'variable';
    dataFile.hidden = repeat.value !== 'file';
  };
  repeat.addEventListener('change', drawRepeat);
  const readForEach = () => {
    if (repeat.value === 'variable') return { kind: 'variable', value: variable.value };
    if (repeat.value === 'file') return { kind: 'file', file: dataFile.value.trim() };
    if (repeat.value !== 'list') return null;
    const names = [...itemsHead.querySelectorAll('input')].map(i => i.value.trim());
    return {
      kind: 'list',
      columns: names.filter(Boolean),
      items: [...itemsBody.children].map(row => Object.fromEntries(names.map((n, i) => [n, row.children[i].querySelector('input').value]).filter(([n]) => n)))
    };
  };

  // until: the call is sent again, every so often, until these conditions hold or the time is up.
  const untilOn = h('input', { type: 'checkbox', id: 'step-until', checked: Boolean(initial.until) });
  const every = control('input', { id: 'step-every', value: initial.until?.every ?? '', placeholder: '1s' });
  const timeout = control('input', { id: 'step-timeout', value: initial.until?.timeout ?? '', placeholder: '30s' });
  const untilStatus = control('input', { id: 'step-until-status', value: initial.until?.status ?? '', placeholder: 'any status while waiting' });
  const untilRows = h('div', { class: 'rows' });
  const untilPlaces = editing.CHECK_PLACES.filter(([k]) => k !== 'duration');
  (initial.until?.checks ?? []).forEach(c => addCheck(c, untilRows, untilPlaces));
  const untilArea = h('div', { class: 'until-detail' },
    h('div', { class: 'inline-fields' },
      h('label', { for: 'step-every' }, 'every'), every,
      h('label', { for: 'step-timeout' }, 'for at most'), timeout,
      h('label', { for: 'step-until-status' }, 'status'), untilStatus),
    untilRows,
    h('button', { type: 'button', class: 'button small', onclick: () => addCheck(undefined, untilRows, untilPlaces) }, '+ Condition'));
  const drawUntil = () => { untilArea.hidden = !untilOn.checked; };
  untilOn.addEventListener('change', drawUntil);
  const addSave = (s = { name: '', path: '$.' }) => {
    const row = h('div', { class: 'row' },
      control('input', { value: s.name, placeholder: 'userId', 'aria-label': 'Variable' }),
      control('input', { value: s.path, placeholder: '$.id', 'aria-label': 'JSONPath of the value to save' }),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Remove this save', onclick: () => row.remove() }, '✕'));
    saveRows.append(row);
  };
  (initial.checks ?? []).forEach(c => addCheck(c));
  (initial.saves ?? []).forEach(addSave);
  call.addEventListener('change', drawWith);

  const nameLabel = h('label', { for: 'step-name' }, 'Name');
  const usePart = h('div', { class: 'form' },
    h('label', { for: 'step-use' }, 'Sequence'), sequence,
    h('label', null, 'Values'), useArea,
    h('div', { class: 'hint' }, 'The steps of the sequence run here, with these values for its params; what they save is seen by the next steps.'));
  const callPart = h('div', null,
    h('div', { class: 'form' },
      h('label', { for: 'step-call' }, 'Endpoint'), call,
      h('label', null, 'Values'), withArea,
      h('label', { for: 'step-repeat' }, 'Repeat'), repeatArea,
      h('div', { class: 'hint' }, "Each item's values are arguments of the call, like Values, and variables of the step (${code}). A variable holds a list saved by an earlier step; a file is a .csv or .json next to the workflow."),
      h('label', { for: 'step-until' }, 'Wait'), h('div', null, h('label', { class: 'toggle', for: 'step-until' }, untilOn, ' Call again until these conditions hold'), untilArea),
      h('label', { for: 'step-status' }, 'Status'), status_,
      h('label', null, 'Checks'), h('div', null, checkRows, h('button', { type: 'button', class: 'button small', onclick: () => addCheck() }, '+ Check')),
      h('div', { class: 'hint' }, 'A check reads the JSON body by its path ($.id, $.items[0].name, $ for all of it), a header or a cookie by its name, or the duration of the response (< 500ms). "is one of" takes values separated by commas.'),
      h('label', null, 'Save'), h('div', null, saveRows, h('button', { type: 'button', class: 'button small', onclick: () => addSave() }, '+ Save a value')),
      h('div', { class: 'hint' }, 'A saved value is used by the next steps as ${name}: a token, an id.')));
  const extraPart = h('details', { class: 'more step-extra', open: Boolean(initial.extra) },
    h('summary', null, initial.extra ? 'More of this step, in YAML' : 'More, in YAML: schema and any checks, saving a cookie…'),
    h('p', { class: 'aside' }, 'What the form does not show, with the keys of the step: schema and any checks, saving a cookie, values that are lists or objects. It is written with the form, under the same keys.'),
    extra);
  const sleepPart = h('div', { class: 'form' }, h('label', { for: 'step-sleep' }, 'Wait'), sleep);
  const toggle = () => {
    callPart.hidden = kind.value !== 'call';
    usePart.hidden = kind.value !== 'use';
    sleepPart.hidden = kind.value !== 'sleep';
    extraPart.hidden = kind.value === 'sleep';
    nameLabel.hidden = name.hidden = kind.value === 'sleep';
    name.placeholder = kind.value === 'use' ? "Empty: the sequence's own name in the report" : 'What this step checks, e.g. The user can be read';
  };
  kind.addEventListener('change', toggle);
  drawWith();
  drawUse();
  drawRepeat();
  drawUntil();
  toggle();

  return h('form', { onsubmit: event => {
    event.preventDefault();
    if (kind.value === 'sleep') return onSave({ kind: 'sleep', sleep: sleep.value });
    const step = kind.value === 'use' ? {
      kind: 'use',
      name: name.value.trim(),
      use: sequence.value,
      with: rowValues(useArea),
      extra: extra.value
    } : {
      kind: 'call',
      name: name.value.trim(),
      call: call.value,
      with: rowValues(withArea),
      status: status_.value,
      checks: readChecks(checkRows),
      forEach: readForEach(),
      until: untilOn.checked ? { every: every.value, timeout: timeout.value, status: untilStatus.value, checks: readChecks(untilRows) } : null,
      saves: [...saveRows.children].map(r => ({ name: r.children[0].value.trim(), path: r.children[1].value.trim() })).filter(s => s.name && s.path),
      extra: extra.value
    };
    if (step.kind === 'call' && !step.call) return status.replaceChildren(h('div', { class: 'notice' }, 'Pick the endpoint the step calls.'));
    if (step.kind === 'use' && !step.use) return status.replaceChildren(h('div', { class: 'notice' }, 'Pick the sequence the step runs.'));
    // The YAML typed in the box is checked here, so a mistake is shown before anything is written.
    try {
      editing.stepYaml(step, 0);
    } catch (e) {
      return status.replaceChildren(h('div', { class: 'notice' }, e.message));
    }
    onSave(step);
  } },
    h('div', { class: 'form' }, h('label', { for: 'step-kind' }, 'Step'), kind, nameLabel, name),
    callPart, usePart, sleepPart, extraPart,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'button primary' }, 'Save'), onCancel ? h('button', { type: 'button', class: 'button', onclick: onCancel }, 'Cancel') : null,
      onYaml ? h('span', { class: 'spacer' }) : null, onYaml ? h('button', { type: 'button', class: 'button', onclick: onYaml }, 'Edit as YAML') : null),
    status);
}

export function stepEditView({ file, index, line, afterLine }) {
  const back = { kind: 'workflow', file };
  // From the diagram and the list a step is known by its line: inspect counts the steps of a sequence too.
  const title = index === null ? 'Add a step' : index === undefined ? 'Edit a step' : `Edit step ${index + 1}`;
  return editorShell(title, file, source => {
    const blocks = (source.inspect?.blocks ?? []).filter(b => b.kind === 'step');
    if (index === undefined) {
      index = editing.stepAt(blocks, line);
      if (index < 0) return h('div', { class: 'notice' }, 'This step is no longer in the file.');
    }
    // A new step goes after the one it was asked from, or at the end.
    const after = afterLine === undefined ? blocks.length - 1 : editing.stepAt(blocks, afterLine);
    if (index === null && after < 0) return h('div', { class: 'notice' }, 'The step to add after is no longer in the file.');
    const endpoints = source.inspect?.endpoints ?? [];
    const status = h('div', { 'aria-live': 'polite' });
    let initial = { kind: 'call', call: endpoints[0]?.name };
    if (index !== null) {
      initial = editing.stepFromSource(source.inspect?.source?.steps?.[index]);
      if (initial.unsupported) return yamlOnly('step', file, { reasons: initial.unsupported, key: { kind: 'step', index } }, back);
    }
    const block = index === null ? null : blocks[index];
    const blockText = block ? source.text.split('\n').slice(block.start.line - 1, block.end.line).join('\n') : '';
    const sequences = state.model.sequences.map(q => ({ path: q.path, name: q.name, params: q.inspect.params ?? [] }));
    const form = stepForm({
      endpoints, sequences, file, initial, status,
      onCancel: () => select(back),
      onYaml: block ? () => select({ kind: 'yaml', file, block: { kind: 'step', index }, back }) : null,
      onSave: async step => {
        const block = index === null ? blocks[after] : blocks[index];
        const yaml = editing.stepYaml(step, editing.indentOf(block));
        const next = index === null ? editing.insertAfter(source.text, block, yaml) : editing.replaceBlock(source.text, block, yaml);
        if (await saveFile(file, next, source.text, status)) {
          showMessage(index === null ? `Added step ${after + 2} to ${file}.` : `Saved step ${index + 1}.`, 'info');
          select(back);
        }
      }
    });
    return h('div', null,
      index === null && afterLine !== undefined ? h('p', { class: 'lead' }, `It goes after step ${after + 1}, ${stepLabel(source.inspect?.source?.steps?.[after])}.`) : null,
      /(^|\s)#/.test(blockText) ? h('div', { class: 'notice info' }, 'The comments inside this step are not kept when it is saved from the form; those around it are. Use Edit as YAML to keep them.') : null,
      form);
  });
}

/** A new workflow: its name, the API files it imports, and its first step. */
export function newWorkflowView() {
  const apiFiles = state.model.apis.filter(a => !a.workflow);
  if (apiFiles.length === 0) {
    return h('div', null, h('h1', null, 'New workflow'), h('div', { class: 'notice info' }, 'A workflow calls the endpoints of API files: add a request first with + New request.'));
  }
  const status = h('div', { 'aria-live': 'polite' });
  const name = control('input', { id: 'workflow-name', class: 'input', placeholder: 'Smoke test' });
  const picks = apiFiles.map(a => ({ file: a.path, box: h('input', { type: 'checkbox', checked: true, id: `import-${a.path}` }) }));
  const stepArea = h('div');
  const endpointsOf = () => apiFiles.filter(a => picks.find(p => p.file === a.path).box.checked).flatMap(a => a.endpoints);
  const drawStep = () => stepArea.replaceChildren(stepForm({
    endpoints: endpointsOf(), initial: { kind: 'call', call: endpointsOf()[0]?.name }, status,
    onSave: async step => {
      const target = editing.workflowFileName(name.value);
      if (!target) return status.replaceChildren(h('div', { class: 'notice' }, 'Give the workflow a name, e.g. Smoke test'));
      if (state.listing.files.some(f => f.path === target)) return status.replaceChildren(h('div', { class: 'notice' }, `${target} already exists.`));
      const imports = picks.filter(p => p.box.checked).map(p => editing.relativePath(target, p.file));
      if (imports.length === 0) return status.replaceChildren(h('div', { class: 'notice' }, 'Pick at least one API file.'));
      if (await saveFile(target, editing.newWorkflowFile({ name: name.value.trim(), imports, step }), null, status)) {
        showMessage(`Created ${target}.`, 'info');
        select({ kind: 'workflow', file: target });
      }
    }
  }));
  for (const p of picks) p.box.addEventListener('change', drawStep);
  drawStep();
  return h('div', null,
    h('h1', null, 'New workflow'),
    h('p', { class: 'lead' }, 'A workflow is a test: steps that call endpoints, check the answers and pass values from one step to the next. It starts with one step; add the others from its Edit view.'),
    h('div', { class: 'form' },
      h('label', { for: 'workflow-name' }, 'Name'), name,
      h('label', null, 'Uses the API'), h('div', null, picks.map(p => h('label', { class: 'check', for: p.box.id }, p.box, ` ${p.file}`)))),
    h('h2', null, 'First step'),
    stepArea);
}

/**
 * Duplicate, Add after and Delete for a step of the diagram, known by its line in the file (a step from a sequence
 * is its use step). The file is read again first, so the action applies to what is there now.
 */
export function stepActions(workflow, step) {
  const line = step.location?.line;
  const file = workflow.path;
  if (!state.info.editing || !line || slash(step.location.file) !== file && !slash(step.location.file).endsWith(`/${file}`)) return [];
  const what = step.sequence ? 'the use step that runs this sequence' : 'this step';
  const located = async () => {
    const source = await api(`/api/source?${query({ root: state.root, path: file })}`);
    const blocks = (source.inspect?.blocks ?? []).filter(b => b.kind === 'step');
    const index = editing.stepAt(blocks, line);
    if (index < 0) throw new Error('This step is no longer in the file: it changed on disk.');
    return { source, blocks, index };
  };
  const failed = e => { if (!(e instanceof RestartError)) showMessage(e.message); };
  return [
    h('button', { type: 'button', class: 'button small', title: `A copy of ${what}, right after it`, onclick: async () => {
      try {
        const { source, blocks, index } = await located();
        const status = h('div');
        if (await saveFile(file, editing.duplicateStep(source.text, blocks[index]), source.text, status)) {
          showMessage(`Added a copy of step ${index + 1} after it.`, 'info');
          renderView();
        } else {
          $('results').prepend(status);
        }
      } catch (e) { failed(e); }
    } }, '⧉ Duplicate'),
    h('button', { type: 'button', class: 'button small', title: `A new step after ${what}`, onclick: () => select({ kind: 'edit-step', file, index: null, afterLine: line }) }, '+ Add after'),
    h('button', { type: 'button', class: 'button small', title: `Delete ${what}`, 'aria-label': `Delete step ${step.index + 1}`, onclick: async () => {
      try {
        const { blocks, index } = await located();
        if (blocks.length === 1) return showMessage('A workflow needs one step: this is the only one.');
        await deleteBlock(file, 'step', index, `step ${index + 1} (${step.sequence ? `use ${step.sequence.name || step.sequence.file}` : step.name})`, renderView);
      } catch (e) { failed(e); }
    } }, '✕ Delete')
  ];
}
