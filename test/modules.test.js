// The page's ES modules (web/app/) import every name of another module they use. A missing import is not seen
// when a module loads, only when the line that uses it runs: a class left out of the exports broke the error
// handling of 0.4.11 to 0.4.13 without a single failing test. This reads the modules as text, which is enough
// for code written as this one is.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'web', 'app');
const files = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(root, f));

/** The code without comments and strings; template literals keep their expressions. */
function code(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (text.startsWith('//', i)) { const j = text.indexOf('\n', i); i = j < 0 ? text.length : j; continue; }
    if (text.startsWith('/*', i)) { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j + 1; out += ' '; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text.startsWith('${', j)) {
          let depth = 1, k = j + 2;
          while (k < text.length && depth) { depth += text[k] === '{' ? 1 : text[k] === '}' ? -1 : 0; k++; }
          out += ` ${code(text.slice(j + 2, k - 1))} `; j = k; continue;
        }
        j++;
      }
      i = j + 1; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};]\s*$/.test(out.slice(-40) || '(')) {
      // A regular expression literal.
      let j = i + 1;
      while (j < text.length && text[j] !== '/') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') while (j < text.length && text[j] !== ']') j++;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(text[i] ?? '')) i++;
      out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

const declaration = /^(?:export )?(?:async function|function|const|let|class) ([\w$]+)/gm;
const modules = files.map(file => {
  const text = fs.readFileSync(file, 'utf8');
  const imports = new Set([...text.matchAll(/^import \{ (.+?) \} from/gm)].flatMap(m => m[1].split(', ')));
  return {
    file: path.relative(root, file),
    text,
    own: new Set([...text.matchAll(declaration)].map(m => m[1])),
    exported: new Set([...text.matchAll(/^export (?:async function|function|const|let|class) ([\w$]+)/gm)].map(m => m[1])),
    imports
  };
});

test('every name a module uses from another module is imported', () => {
  // Every top-level name of another module, exported or not: a name left out of the exports is the same mistake.
  const exportedBy = new Map();
  for (const m of modules) for (const name of m.own) exportedBy.set(name, m.file);
  const missing = [];
  for (const m of modules) {
    // A spread (`...nodes(`) is not a property access.
    const body = code(m.text.replace(/^import .*$/gm, '')).replaceAll('...', ' ');
    for (const [, name] of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
      if (exportedBy.has(name) && !m.own.has(name) && !m.imports.has(name) && !locals(m.text).has(name)) {
        missing.push(`${m.file}: ${name} (from ${exportedBy.get(name)})`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('every imported name is exported by its module', () => {
  const byFile = new Map(modules.map(m => [m.file, m]));
  const wrong = [];
  for (const m of modules) {
    for (const [, names, from] of m.text.matchAll(/^import \{ (.+?) \} from '(.+?)';/gm)) {
      const target = byFile.get(path.relative(root, path.join(root, path.dirname(m.file), from)));
      for (const name of names.split(', ')) if (!target?.exported.has(name)) wrong.push(`${m.file}: ${name} from ${from}`);
    }
  }
  assert.deepEqual(wrong, []);
});

/** Parameters and local declarations that reuse the name of another module's export (`item => ...`). */
function locals(text) {
  const names = new Set();
  for (const [, name] of text.matchAll(/(?:const|let|var) \{?\s*([\w$]+)/g)) names.add(name);
  for (const [, list] of text.matchAll(/\(([^()]*)\)\s*=>/g)) for (const p of list.split(',')) names.add(p.trim().split(/[\s=]/)[0]);
  for (const [, name] of text.matchAll(/([\w$]+)\s*=>/g)) names.add(name);
  return names;
}
