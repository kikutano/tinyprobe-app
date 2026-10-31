// The page's logic that needs no browser: reading ndjson, and writing a new endpoint into an API file.
// It runs in the page and, for the tests, in Node. The app writes YAML as text, so the user's comments and
// order stay; `tinyprobe inspect` checks the result, the app does not trust it.
(function (exports) {
  'use strict';

  /** Splits text that arrives in chunks into lines: an ndjson event can be cut anywhere by the network. */
  class LineSplitter {
    constructor(onLine) {
      this.onLine = onLine;
      this.buffer = '';
    }

    push(chunk) {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim() !== '') this.onLine(line);
      }
    }

    end() {
      const line = this.buffer.trim();
      this.buffer = '';
      if (line !== '') this.onLine(line);
    }
  }

  /** The keys at the top of a YAML mapping, such as the variables of an environment file. */
  function topLevelKeys(text) {
    const keys = [];
    for (const line of String(text).split(/\r?\n/)) {
      const match = /^([A-Za-z_$][\w$.-]*)[ \t]*:(?:[ \t]|$)/.exec(line);
      if (match) keys.push(match[1]);
    }
    return keys;
  }

  /** The children of a top-level key (the auth sets under `auth:`, the endpoints under `endpoints:`). */
  function childKeys(text, parent) {
    const lines = String(text).split(/\r?\n/);
    const start = lines.findIndex(line => new RegExp(`^${parent}[ \\t]*:[ \\t]*(#.*)?$`).test(line));
    if (start < 0) return [];
    const keys = [];
    let indent = null;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line) && !line.startsWith('#')) break;
      const match = /^([ \t]+)([A-Za-z_][\w.-]*)[ \t]*:/.exec(line);
      if (!match) continue;
      if (indent === null) indent = match[1];
      if (match[1] === indent) keys.push(match[2]);
    }
    return keys;
  }

  /** The `${name}` placeholders of some text, in order, without generated values (`${$uuid}`). */
  function placeholders(...texts) {
    const names = [];
    for (const text of texts) {
      for (const match of String(text ?? '').matchAll(/\$\{([A-Za-z_][\w.-]*)\}/g)) {
        if (!names.includes(match[1])) names.push(match[1]);
      }
    }
    return names;
  }

  /** An endpoint's name is a YAML key that `call:` can name: letters, digits, `_` and `-`, no dots (named imports). */
  function checkName(name, existing) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name ?? '')) {
      return `The name '${name ?? ''}' is not valid: use letters, digits and _, e.g. get_user`;
    }
    if ((existing ?? []).includes(name)) return `This file already has an endpoint '${name}'`;
    return null;
  }

  const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

  /** A YAML scalar for a string: plain when YAML reads it back as the same string, double-quoted otherwise. */
  function scalar(value) {
    const text = String(value);
    const plain = text !== '' &&
      text === text.trim() &&
      !RESERVED.test(text) &&
      !/^[-+]?(\d|\.\d)/.test(text) &&
      !/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
      !/[:#]\s|\s#|:$/.test(text) &&
      !/[\n\r\t]/.test(text);
    return plain ? text : JSON.stringify(text);
  }

  /** A value typed in a form, read like YAML as --with reads it: 42 stays a number, true a boolean, the rest a string. */
  function typed(value) {
    const text = String(value).trim();
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) || /^(true|false|null)$/.test(text)) return text;
    if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return text;
    return scalar(value);
  }

  /** A JSON value as block YAML, at the given indentation. */
  function toYaml(value, indent) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
      if (value.length === 0) return ' []';
      return value.map(item => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
          const lines = toYaml(item, indent + 2).replace(/^\n/, '').split('\n');
          lines[0] = `${pad}- ${lines[0].trimStart()}`;
          return '\n' + lines.join('\n');
        }
        return `\n${pad}-${toYaml(item, indent + 2)}`;
      }).join('');
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return ' {}';
      return entries.map(([key, item]) => `\n${pad}${scalar(key)}:${toYaml(item, indent + 2)}`).join('');
    }
    if (typeof value === 'string') return ` ${scalar(value)}`;
    return ` ${JSON.stringify(value)}`;
  }

  /**
   * The YAML of one endpoint, from the new-request form:
   * { name, method, path, query: [names], headers: [{name, value}], body (JSON text), auth, defaults: [{name, value}] }.
   * Query parameters are names, as in the format: each is sent only when the call passes it.
   * Throws an Error with a message for the page when the body is not JSON.
   */
  function endpointYaml(request, indent) {
    const unit = ' '.repeat(indent);
    const lines = [`${unit}${request.name}:`];
    const field = (key, value) => lines.push(`${unit}${unit}${key}:${value}`);
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET') field('method', ` ${method}`);
    field('path', ` ${scalar(request.path || '/')}`);
    if (request.auth) field('auth', ` ${scalar(request.auth)}`);

    const defaults = (request.defaults ?? []).filter(d => d.name);
    if (defaults.length > 0) {
      field('params', defaults.map(d => `\n${unit}${unit}${unit}${scalar(d.name)}:${d.value === '' ? '' : ` ${typed(d.value)}`}`).join(''));
    }
    const query = (request.query ?? []).map(name => String(name).trim()).filter(Boolean);
    if (query.length > 0) field('query', ` [${query.map(scalar).join(', ')}]`);
    const headers = (request.headers ?? []).filter(h => h.name);
    if (headers.length > 0) field('headers', headers.map(h => `\n${unit}${unit}${unit}${scalar(h.name)}: ${scalar(h.value ?? '')}`).join(''));
    if (request.body && request.body.trim() !== '') {
      let body;
      try {
        body = JSON.parse(request.body);
      } catch (e) {
        throw new Error(`The body is not valid JSON: ${e.message}`);
      }
      field('body', toYaml(body, indent * 3));
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Adds an endpoint at the end of the `endpoints:` of an API file, as text. Returns { text } or { error }.
   * A file without `endpoints:` gets one at the end.
   */
  function addEndpoint(text, request) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex(line => /^endpoints[ \t]*:/.test(line));
    if (start >= 0 && !/^endpoints[ \t]*:[ \t]*(#.*)?$/.test(lines[start])) {
      return { error: 'This file writes its endpoints on one line: add the request in an editor.' };
    }

    let indent = 2;
    let end = lines.length;
    if (start >= 0) {
      end = start + 1;
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\S/.test(line) && !line.startsWith('#')) break;
        if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
          end = i + 1;
          const match = /^( +)\S/.exec(line);
          if (match && i === firstChild(lines, start)) indent = match[1].length;
        }
      }
    }

    let block;
    try {
      block = endpointYaml(request, indent).replace(/\n$/, '').split('\n');
    } catch (e) {
      return { error: e.message };
    }
    let result;
    if (start >= 0) {
      result = [...lines.slice(0, end), ...block, ...lines.slice(end)];
    } else {
      const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
      result = [...body, 'endpoints:', ...block];
    }
    let joined = result.join('\n');
    if (!joined.endsWith('\n')) joined += '\n';
    return { text: joined.replace(/\n/g, eol) };
  }

  function firstChild(lines, start) {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() !== '' && !lines[i].trimStart().startsWith('#')) return i;
    }
    return -1;
  }

  /** A new API file: a base URL and the first endpoint. */
  function newApiFile(baseUrl, request) {
    const header = `# API file created by tinyprobe-app. Edit it in any editor: it runs with tinyprobe in a terminal and in CI.\nbase_url: ${scalar(baseUrl || '${baseUrl}')}\n`;
    return addEndpoint(header, request);
  }

  /** `api/shop.yaml` from a name such as "Shop API": what a new API file is called. */
  function apiFileName(name) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? null : `api/${slug}.yaml`;
  }

  Object.assign(exports, { LineSplitter, topLevelKeys, childKeys, placeholders, checkName, scalar, typed, toYaml, endpointYaml, addEndpoint, newApiFile, apiFileName });
})(typeof module === 'object' && module.exports ? module.exports : (globalThis.tinyprobeCore = {}));
