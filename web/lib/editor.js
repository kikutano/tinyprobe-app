// The visual editor's text work (M5-4): forms filled from `inspect --json --source`, and the YAML they write,
// put back into the file between the `start` and `end` of a block (tinyprobe spec 0018). Only the edited block
// changes: the rest of the file, its comments included, stays as it was. tinyprobe checks the result.
(function (exports, core) {
  'use strict';

  const { scalar, typed, toYaml } = core;

  // --- Positions ----------------------------------------------------------------------------------------------

  /** The index in the text of a 1-based { line, column } of tinyprobe. */
  function offsetOf(text, position) {
    let index = 0;
    for (let line = 1; line < position.line; line++) {
      const next = text.indexOf('\n', index);
      if (next < 0) return text.length;
      index = next + 1;
    }
    return index + position.column - 1;
  }

  /**
   * The whole lines of a block: from the start of its first line, when only spaces come before it, to the end of
   * its last line (a comment after the value included), without the line break.
   */
  function lines(text, block) {
    let from = offsetOf(text, block.start);
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    if (/^[ \t]*$/.test(text.slice(lineStart, from))) from = lineStart;
    let to = text.indexOf('\n', offsetOf(text, block.end));
    if (to < 0) to = text.length;
    if (text[to - 1] === '\r') to--;
    return { from, to };
  }

  function eolOf(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
  }

  /** The text with a block's lines replaced by `yaml` (whole lines, with their indentation). */
  function replaceBlock(text, block, yaml) {
    const { from, to } = lines(text, block);
    return text.slice(0, from) + yaml.replace(/\n$/, '').replace(/\n/g, eolOf(text)) + text.slice(to);
  }

  /** The text without a block's lines. */
  function removeBlock(text, block) {
    const { from, to } = lines(text, block);
    let end = to;
    if (text.slice(end, end + 2) === '\r\n') end += 2;
    else if (text[end] === '\n') end += 1;
    return text.slice(0, from) + text.slice(end);
  }

  /** The text with `yaml` on the lines after a block. */
  function insertAfter(text, block, yaml) {
    const { to } = lines(text, block);
    const eol = eolOf(text);
    return text.slice(0, to) + eol + yaml.replace(/\n$/, '').replace(/\n/g, eol) + text.slice(to);
  }

  /** The text with two blocks (two steps) swapped; `a` comes before `b`. */
  function swapBlocks(text, a, b) {
    const first = lines(text, a);
    const second = lines(text, b);
    return text.slice(0, first.from) + text.slice(second.from, second.to) + text.slice(first.to, second.from)
      + text.slice(first.from, first.to) + text.slice(second.to);
  }

  /** The indentation of a block: the spaces before its key, or before the `-` of a list item. */
  function indentOf(block) {
    return block.start.column - 1;
  }

  // --- Values ----------------------------------------------------------------------------------------------

  /** A value of the file shown in a form field, so that writing it back with typed() gives the same value. */
  function display(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
      // A string that YAML would read as another type keeps its quotes.
      return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) || /^(true|false|null)$/.test(value) ? JSON.stringify(value) : value;
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** A value inside `{ ... }` or `[ ... ]`: numbers, booleans and null as they are, any text quoted. */
  function flowValue(value) {
    const text = String(value).trim();
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) || /^(true|false|null)$/.test(text)) return text;
    if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return text;
    return JSON.stringify(text);
  }

  // --- Endpoints -------------------------------------------------------------------------------------------

  /**
   * The new-request form from an endpoint of `source.endpoints`, or { unsupported } with why the form cannot
   * show it (then it is edited as YAML).
   */
  function requestFromSource(name, endpoint) {
    const unsupported = ['form', 'multipart'].filter(key => endpoint[key] !== undefined).map(key => `a ${key} body`);
    if (endpoint.headers && (typeof endpoint.headers !== 'object' || Array.isArray(endpoint.headers))) unsupported.push('headers that are not a mapping');
    if (unsupported.length > 0) return { unsupported };
    return {
      name,
      method: endpoint.method ?? 'GET',
      path: endpoint.path ?? '',
      auth: Array.isArray(endpoint.auth) ? endpoint.auth.join(', ') : endpoint.auth ?? '',
      query: (endpoint.query ?? []).join(', '),
      headers: Object.entries(endpoint.headers ?? {}).map(([n, v]) => ({ name: n, value: display(v) })),
      body: endpoint.body === undefined ? '' : JSON.stringify(endpoint.body, null, 2),
      defaults: Object.entries(endpoint.params ?? {}).map(([n, v]) => ({ name: n, value: display(v) }))
    };
  }

  // --- Auth sets -----------------------------------------------------------------------------------------------

  /** The kinds of auth set the form writes. */
  const AUTH_KINDS = ['bearer', 'header', 'basic', 'oauth2'];

  function authFromSource(name, set) {
    const keys = Object.keys(set ?? {});
    if (set?.basic && keys.length === 1) return { name, kind: 'basic', username: display(set.basic.username), password: display(set.basic.password) };
    if (set?.oauth2 && keys.length === 1) {
      const o = set.oauth2;
      const known = ['token_url', 'client_id', 'client_secret', 'scope'];
      if (Object.keys(o).some(k => !known.includes(k))) return { unsupported: ['oauth2 options the form does not show'] };
      return { name, kind: 'oauth2', tokenUrl: display(o.token_url), clientId: display(o.client_id), clientSecret: display(o.client_secret), scope: display(Array.isArray(o.scope) ? o.scope.join(' ') : o.scope) };
    }
    if (keys.length === 1 && typeof set[keys[0]] === 'string') {
      const bearer = /^Authorization$/i.test(keys[0]) && /^Bearer (.*)$/.exec(set[keys[0]]);
      if (bearer) return { name, kind: 'bearer', token: bearer[1] };
      return { name, kind: 'header', header: keys[0], value: set[keys[0]] };
    }
    return { unsupported: ['several headers in one auth set'] };
  }

  /** The YAML of an auth set, an entry of `auth:` at the given indentation. */
  function authSetYaml(auth, indent) {
    const pad = ' '.repeat(indent);
    const inner = ' '.repeat(indent + 2);
    const deeper = ' '.repeat(indent + 4);
    const lines = [`${pad}${auth.name}:`];
    if (auth.kind === 'bearer') lines.push(`${inner}Authorization: ${JSON.stringify(`Bearer ${auth.token}`)}`);
    else if (auth.kind === 'header') lines.push(`${inner}${scalar(auth.header)}: ${scalar(auth.value ?? '')}`);
    else if (auth.kind === 'basic') lines.push(`${inner}basic:`, `${deeper}username: ${typed(auth.username ?? '')}`, `${deeper}password: ${typed(auth.password ?? '')}`);
    else if (auth.kind === 'oauth2') {
      lines.push(`${inner}oauth2:`, `${deeper}token_url: ${scalar(auth.tokenUrl ?? '')}`, `${deeper}client_id: ${typed(auth.clientId ?? '')}`, `${deeper}client_secret: ${typed(auth.clientSecret ?? '')}`);
      if (auth.scope) lines.push(`${deeper}scope: ${scalar(auth.scope)}`);
    }
    return lines.join('\n') + '\n';
  }

  function checkAuthName(name, existing) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name ?? '')) return `The name '${name ?? ''}' is not valid: use letters, digits and _, e.g. bearer`;
    if ((existing ?? []).includes(name)) return `This file already has an auth set '${name}'`;
    return null;
  }

  /**
   * Adds an auth set to an API file: after the last one, or in a new `auth:` before `endpoints:`.
   * `blocks` are those of `inspect --source` for this text.
   */
  function addAuthSet(text, blocks, auth) {
    const sets = blocks.filter(b => b.kind === 'auth');
    if (sets.length > 0) return insertAfter(text, sets[sets.length - 1], authSetYaml(auth, indentOf(sets[0])));
    const authKey = blocks.find(b => b.kind === 'key' && b.name === 'auth');
    if (authKey) return replaceBlock(text, authKey, `auth:\n${authSetYaml(auth, 2)}`);
    const endpoints = blocks.find(b => b.kind === 'key' && b.name === 'endpoints');
    const section = `auth:\n${authSetYaml(auth, 2)}`;
    if (!endpoints) return text.replace(/\n?$/, '\n') + section;
    const { from } = lines(text, endpoints);
    return text.slice(0, from) + section.replace(/\n/g, eolOf(text)) + text.slice(from);
  }

  // --- Steps ---------------------------------------------------------------------------------------------------

  /** The check operators the form offers, with the word people see. */
  const OPERATORS = [
    ['eq', 'equals'], ['ne', 'differs from'], ['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<='],
    ['contains', 'contains'], ['in', 'is one of'], ['matches', 'matches'], ['exists', 'exists']
  ];
  const OPERATOR_KEYS = OPERATORS.map(([key]) => key);

  /**
   * The step form from an item of `source.steps`, or { unsupported } with what only YAML can say:
   * `use`, `until`, `for_each`, checks on headers, cookies or duration, `any`, `schema`, cookie saves.
   */
  function stepFromSource(step) {
    if (step && typeof step === 'object' && Object.keys(step).length === 1 && step.sleep !== undefined) return { kind: 'sleep', sleep: display(step.sleep) };
    const unsupported = [];
    const known = ['name', 'call', 'with', 'expect', 'save'];
    for (const key of Object.keys(step ?? {})) if (!known.includes(key)) unsupported.push(key);
    const expect = step?.expect ?? {};
    for (const key of Object.keys(expect)) if (!['status', 'body'].includes(key)) unsupported.push(`checks on ${key}`);
    const checks = [];
    for (const [path, condition] of Object.entries(expect.body ?? {})) {
      if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
        for (const [op, value] of Object.entries(condition)) {
          if (!OPERATOR_KEYS.includes(op)) unsupported.push(`${op} checks`);
          else checks.push({ path, op, value: op === 'in' && Array.isArray(value) ? value.map(display).join(', ') : display(value) });
        }
      } else {
        checks.push({ path, op: 'eq', value: display(condition) });
      }
    }
    const saves = [];
    for (const [name, from] of Object.entries(step?.save ?? {})) {
      if (typeof from === 'string') saves.push({ name, path: from });
      else unsupported.push('saving a cookie');
    }
    if (unsupported.length > 0) return { unsupported: [...new Set(unsupported)] };
    const status = expect.status === undefined ? '' : Array.isArray(expect.status) ? expect.status.join(', ') : display(expect.status);
    return {
      kind: 'call',
      name: step.name ?? '',
      call: step.call ?? '',
      with: Object.entries(step.with ?? {}).map(([n, v]) => ({ name: n, value: display(v) })),
      status,
      checks,
      saves
    };
  }

  /** The YAML of a step, a list item at the given indentation. */
  function stepYaml(step, indent) {
    const pad = ' '.repeat(indent);
    if (step.kind === 'sleep') {
      // A duration such as 2s or 500ms is written as it is, not quoted as a string that starts with a digit.
      const duration = String(step.sleep).trim();
      return `${pad}- sleep: ${/^\d+(\.\d+)?(ms|s|m|h)$/.test(duration) ? duration : scalar(duration)}\n`;
    }
    const inner = ' '.repeat(indent + 2);
    const deeper = ' '.repeat(indent + 4);
    const deepest = ' '.repeat(indent + 6);
    const lines = [];
    const push = line => lines.push(lines.length === 0 ? `${pad}- ${line}` : `${inner}${line}`);
    if (step.name) push(`name: ${scalar(step.name)}`);
    push(`call: ${scalar(step.call)}`);
    const withValues = (step.with ?? []).filter(w => w.name && w.value !== '');
    if (withValues.length > 0) {
      push('with:');
      for (const w of withValues) lines.push(`${deeper}${scalar(w.name)}: ${typed(w.value)}`);
    }
    const codes = String(step.status ?? '').split(',').map(c => c.trim()).filter(Boolean);
    const checks = (step.checks ?? []).filter(c => c.path);
    if (codes.length > 0 || checks.length > 0) {
      push('expect:');
      if (codes.length === 1) lines.push(`${deeper}status: ${codes[0]}`);
      else if (codes.length > 1) lines.push(`${deeper}status: [${codes.join(', ')}]`);
      if (checks.length > 0) {
        lines.push(`${deeper}body:`);
        // Several operators on one path become one mapping: all of them must pass.
        const byPath = new Map();
        for (const c of checks) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
        for (const [path, conditions] of byPath) {
          const plain = conditions.length === 1 && conditions[0].op === 'eq';
          const value = c => c.op === 'in'
            ? `[${String(c.value).split(',').map(v => v.trim()).filter(Boolean).map(flowValue).join(', ')}]`
            : c.op === 'exists' ? (/^false$/i.test(String(c.value).trim()) ? 'false' : 'true')
            : flowValue(c.value);
          lines.push(plain
            ? `${deepest}${scalar(path)}: ${typed(conditions[0].value)}`
            : `${deepest}${scalar(path)}: { ${conditions.map(c => `${c.op}: ${value(c)}`).join(', ')} }`);
        }
      }
    }
    const saves = (step.saves ?? []).filter(s => s.name && s.path);
    if (saves.length > 0) {
      push('save:');
      for (const s of saves) lines.push(`${deeper}${scalar(s.name)}: ${scalar(s.path)}`);
    }
    return lines.join('\n') + '\n';
  }

  /** A new workflow file: its name, its imports and its first step. */
  function newWorkflowFile({ name, imports, step }) {
    const lines = [`name: ${scalar(name)}`];
    if (imports.length > 0) {
      lines.push('import:');
      for (const file of imports) lines.push(`  - ${scalar(file)}`);
    }
    lines.push('steps:');
    return lines.join('\n') + '\n' + stepYaml(step, 2);
  }

  /** `workflows/smoke-test.yaml` from a name such as "Smoke test". */
  function workflowFileName(name) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? null : `workflows/${slug}.yaml`;
  }

  /** The path of `target` relative to the folder of `from`, both relative to the same root, with `/`. */
  function relativePath(from, target) {
    const base = from.split('/').slice(0, -1);
    const parts = target.split('/');
    while (base.length > 0 && parts.length > 1 && base[0] === parts[0]) {
      base.shift();
      parts.shift();
    }
    return [...base.map(() => '..'), ...parts].join('/');
  }

  Object.assign(exports, {
    offsetOf, replaceBlock, removeBlock, insertAfter, swapBlocks, indentOf,
    display, requestFromSource, AUTH_KINDS, authFromSource, authSetYaml, checkAuthName, addAuthSet,
    OPERATORS, stepFromSource, stepYaml, newWorkflowFile, workflowFileName, relativePath
  });
})(typeof module === 'object' && module.exports ? module.exports : (globalThis.tinyprobeEditor = {}),
  typeof module === 'object' && module.exports ? require('./core.js') : globalThis.tinyprobeCore);
