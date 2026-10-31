// The picture of a workflow: its steps in order, the values each one saves and the steps that use them, lit up
// as a run goes. Everything comes from `tinyprobe inspect --json` and the ndjson events of `tinyprobe run`.
// Shared by tinyprobe-app and the VS Code extension, which copies this file: the model is plain JavaScript that
// runs in Node too; the drawing needs a document. Every text is set with textContent, never as HTML.
(function (exports) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';

  /** The `${name}` placeholders in a value, deep, without generated values (`${$uuid}`). */
  function placeholders(value, found = new Set()) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][\w.-]*)\}/g)) found.add(match[1]);
    } else if (Array.isArray(value)) {
      for (const item of value) placeholders(item, found);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) placeholders(item, found);
    }
    return found;
  }

  function baseName(path) {
    return String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  }

  /**
   * The workflow as a flow: one node per step (in the order `inspect` lists them, the steps of a sequence where
   * its `use` is), one lane per saved value from the step that saves it to the steps that use it, and the values
   * that come from elsewhere. A step uses a value when `${name}` is in its `with`, or when the called endpoint
   * needs it and the `with` does not give it.
   * @param {object} inspect the `inspect --json` document of a workflow
   * @param {string[]} environment the variable names of the selected environment file
   */
  function flowModel(inspect, environment) {
    const fromEnvironment = new Set(environment ?? []);
    const variables = new Set((inspect.variables ?? []).map(v => v.name));
    const endpoints = new Map((inspect.endpoints ?? []).map(e => [e.name, e]));
    const nodes = [];
    const lanes = [];
    const latest = new Map();
    const inputs = { environment: [], variables: [], other: [] };
    const addInput = (kind, name) => { if (!inputs[kind].includes(name)) inputs[kind].push(name); };

    for (const step of inspect.steps ?? []) {
      const node = {
        index: step.index,
        name: step.name,
        type: step.type,
        sequence: step.sequence ? (step.sequence.name || baseName(step.sequence.file)) : null,
        saves: [],
        uses: []
      };
      if (step.type === 'sleep') {
        node.duration = step.duration_ms ?? null;
      } else if (step.type === 'call') {
        const endpoint = endpoints.get(step.call);
        node.call = step.call;
        node.method = endpoint?.method ?? null;
        node.path = endpoint?.path ?? null;
        node.until = step.until ? { every: step.until.every_ms, timeout: step.until.timeout_ms } : null;
        node.forEach = step.for_each
          ? (Array.isArray(step.for_each.items) ? step.for_each.items.length : step.for_each.variable ? `\${${step.for_each.variable}}` : '?')
          : null;

        const given = step.with ?? {};
        const used = placeholders(given);
        // What the endpoint needs and the step does not give: a value of the run, or a param's default.
        const defaults = new Set((endpoint?.params ?? []).filter(p => !p.required).map(p => p.name));
        const optional = new Set([...(endpoint?.query ?? []), ...defaults]);
        for (const argument of endpoint?.arguments ?? []) {
          if (Object.prototype.hasOwnProperty.call(given, argument)) continue;
          if (optional.has(argument) && !latest.has(argument) && !fromEnvironment.has(argument) && !variables.has(argument)) continue;
          used.add(argument);
        }
        // The keys of a for_each's items are the item's own values.
        for (const item of step.for_each?.items ?? []) {
          if (item && typeof item === 'object') for (const key of Object.keys(item)) used.delete(key);
        }
        if (step.for_each?.variable) used.add(step.for_each.variable);

        for (const name of used) {
          if (latest.has(name)) {
            const lane = latest.get(name);
            lane.to.push(nodes.length);
            node.uses.push({ name, lane: lane.id });
          } else if (fromEnvironment.has(name)) addInput('environment', name);
          else if (variables.has(name)) addInput('variables', name);
          // In a sequence, the params come from the `with` of its `use`; in a for_each, from each item.
          else if (!node.sequence && !step.for_each) addInput('other', name);
        }
        for (const name of Object.keys(step.save ?? {})) {
          const lane = { id: lanes.length, name, from: nodes.length, to: [] };
          lanes.push(lane);
          latest.set(name, lane);
          node.saves.push({ name, lane: lane.id });
        }
      }
      nodes.push(node);
    }
    return { nodes, lanes, inputs };
  }

  // --- Drawing -------------------------------------------------------------------------------------------------

  const NODE_X = 8;
  const NODE_W = 470;
  const LANE_GAP = 26;
  const LANE_START = 30;
  const GAP = 14;
  const GROUP_LABEL = 22;
  const LANE_COLORS = 6;

  function svg(tag, attributes, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes ?? {})) {
      if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function duration(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${Math.round(ms / 100) / 10}s`;
  }

  function shorten(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  /**
   * Draws the flow in `root` and returns { apply(event), reset(), select(position) }. `onSelect(position)` is
   * called when a step is clicked or chosen with the keyboard.
   */
  function createFlow(root, model, { onSelect, selected = null } = {}) {
    let states = [];
    let current = selected;

    function reset() {
      states = model.nodes.map(() => ({ status: 'pending', attempt: 1, item: null, items: null, result: null }));
      draw();
    }

    function position(index) {
      return model.nodes.findIndex(n => n.index === index);
    }

    /** One ndjson event of a run of this workflow. */
    function apply(event) {
      if (event.event === 'run_started') {
        reset();
        return;
      }
      const at = position(event.index);
      if (event.event === 'step_started' && at >= 0) {
        // A step that starts ends the sleep before it, which has no step_completed.
        states.forEach((s, i) => { if (i < at && s.status === 'running') s.status = 'passed'; });
        Object.assign(states[at], { status: 'running', attempt: event.attempt ?? 1, item: event.iteration ?? null, items: event.iterations ?? null });
      } else if (event.event === 'step_completed' && at >= 0) {
        Object.assign(states[at], { status: event.success ? 'passed' : 'failed', result: event });
      } else if (event.event === 'run_finished') {
        for (const s of states) {
          if (s.status === 'running') s.status = 'passed';
          else if (s.status === 'pending') s.status = 'skipped';
        }
      }
      draw();
    }

    function select(at) {
      current = at;
      draw();
      onSelect?.(at);
    }

    function draw() {
      const nodes = model.nodes;
      const heights = nodes.map(n => (n.type === 'call' && (n.saves.length || n.uses.length) ? 70 : 52));
      const tops = [];
      let y = 6;
      nodes.forEach((node, i) => {
        if (node.sequence && (i === 0 || nodes[i - 1].sequence !== node.sequence)) y += GROUP_LABEL;
        tops.push(y);
        y += heights[i] + GAP;
      });
      const width = NODE_X + NODE_W + LANE_START + Math.max(model.lanes.length, 1) * LANE_GAP + 8;
      const height = Math.max(y, 40);
      const center = i => tops[i] + heights[i] / 2;

      const picture = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'flow-svg', role: 'list', 'aria-label': 'The steps of the workflow and the values they pass on' });
      picture.style.maxWidth = `${width}px`;

      const defs = svg('defs');
      for (let c = 0; c < LANE_COLORS; c++) {
        const marker = svg('marker', { id: `flow-arrow-${c}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
        marker.append(svg('path', { d: 'M0,0 L8,4 L0,8 z', class: `flow-lane-fill lane-${c}` }));
        defs.append(marker);
      }
      picture.append(defs);

      // The groups of a sequence's steps, behind them.
      let start = null;
      nodes.forEach((node, i) => {
        if (node.sequence && start === null) start = i;
        const ends = node.sequence && (i === nodes.length - 1 || nodes[i + 1].sequence !== node.sequence);
        if (ends) {
          const top = tops[start] - GROUP_LABEL + 2;
          picture.append(svg('rect', { x: 1, y: top, width: NODE_W + 14, height: tops[i] + heights[i] - top + 7, rx: 10, class: 'flow-group' }));
          picture.append(svg('text', { x: 12, y: top + 15, class: 'flow-group-label' }, `use ${node.sequence}`));
          start = null;
        }
      });

      // The lanes: from the step that saves a value to the last step that uses it.
      model.lanes.forEach(lane => {
        const x = NODE_X + NODE_W + LANE_START + lane.id * LANE_GAP;
        const color = lane.id % LANE_COLORS;
        const from = center(lane.from);
        const last = lane.to.length > 0 ? center(lane.to[lane.to.length - 1]) : from;
        const group = svg('g', { class: `flow-lane lane-${color}` });
        group.append(svg('title', null, `${lane.name}: saved by step ${lane.from + 1}${lane.to.length ? `, used by ${lane.to.map(t => t + 1).join(', ')}` : ', not used afterwards'}`));
        group.append(svg('line', { x1: NODE_X + NODE_W, y1: from, x2: x, y2: from, class: 'flow-lane-line' }));
        if (last !== from) group.append(svg('line', { x1: x, y1: from, x2: x, y2: last, class: 'flow-lane-line' }));
        group.append(svg('circle', { cx: NODE_X + NODE_W, cy: from, r: 4, class: 'flow-lane-fill' }));
        for (const to of lane.to) {
          group.append(svg('line', { x1: x, y1: center(to), x2: NODE_X + NODE_W + 2, y2: center(to), class: 'flow-lane-line', 'marker-end': `url(#flow-arrow-${color})` }));
        }
        picture.append(group);
      });

      nodes.forEach((node, i) => picture.append(drawNode(node, i, tops[i], heights[i])));
      root.replaceChildren(picture);
    }

    function drawNode(node, i, top, height) {
      const state = states[i] ?? { status: 'pending' };
      const group = svg('g', {
        class: `flow-node flow-${state.status}${current === i ? ' flow-selected' : ''}`,
        tabindex: 0, role: 'listitem', 'aria-label': `Step ${i + 1}: ${node.name}, ${state.status}`
      });
      const choose = () => select(i);
      group.addEventListener('click', choose);
      group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });

      group.append(svg('rect', { x: NODE_X, y: top, width: NODE_W, height, rx: 8, class: 'flow-box' }));
      const icon = { pending: '○', running: '●', passed: '✓', failed: '✗', skipped: '–' }[state.status] ?? '○';
      group.append(svg('text', { x: NODE_X + 14, y: top + 21, class: 'flow-icon' }, icon));
      group.append(svg('text', { x: NODE_X + 34, y: top + 21, class: 'flow-name' }, shorten(`${i + 1}. ${node.name}`, 46)));

      // Badges at the right of the first line: polling, items, progress, duration.
      const badges = [];
      if (node.until) badges.push(state.status === 'running' && state.attempt > 1 ? `↻ attempt ${state.attempt}` : `↻ until, every ${duration(node.until.every)}`);
      if (node.forEach !== null && node.forEach !== undefined) {
        badges.push(state.status === 'running' && state.items ? `item ${state.item}/${state.items}` : typeof node.forEach === 'number' ? `× ${node.forEach} items` : `× each of ${node.forEach}`);
      }
      if (state.result) badges.push(`${state.result.status ?? '---'} · ${duration(state.result.duration_ms)}`);
      if (badges.length > 0) group.append(svg('text', { x: NODE_X + NODE_W - 12, y: top + 21, 'text-anchor': 'end', class: 'flow-badge' }, badges.join('   ')));

      const detail = node.type === 'sleep' ? `wait ${duration(node.duration)}`
        : node.type === 'call' ? `${node.method ?? ''} ${node.path ?? ''}  ·  ${node.call}`
        : node.type;
      group.append(svg('text', { x: NODE_X + 34, y: top + 39, class: 'flow-detail' }, shorten(detail, 64)));

      if (node.type === 'call' && (node.saves.length || node.uses.length)) {
        const line = svg('text', { x: NODE_X + 34, y: top + 57, class: 'flow-values' });
        const part = (label, values) => {
          line.append(svg('tspan', { class: 'flow-values-label' }, label));
          values.forEach((v, n) => {
            line.append(svg('tspan', { class: `flow-lane-text lane-${v.lane % LANE_COLORS}` }, ` ● ${v.name}${n < values.length - 1 ? ',' : ''}`));
          });
        };
        if (node.uses.length) part('uses', node.uses);
        if (node.uses.length && node.saves.length) line.append(svg('tspan', null, '    '));
        if (node.saves.length) part('saves', node.saves);
        group.append(line);
      }
      group.append(svg('title', null, `${node.name}${state.result?.failure ? `: ${state.result.failure}` : ''}`));
      return group;
    }

    reset();
    return { apply, reset, select, get selected() { return current; }, state: i => states[i] };
  }

  Object.assign(exports, { flowModel, createFlow, placeholders });
})(typeof module === 'object' && module.exports ? module.exports : (globalThis.tinyprobeFlow = {}));
