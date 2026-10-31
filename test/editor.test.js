'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const editor = require('../web/lib/editor.js');

// A file and the blocks `tinyprobe inspect --json --source` gives for it (spec 0018).
const api = [
  '# Shop',
  'base_url: ${baseUrl}',
  'auth:',
  '  bearer:',
  '    Authorization: "Bearer ${token}"',
  '',
  'endpoints:',
  '  login:',
  '    method: POST',
  '    path: /login   # the token',
  '  # Users by id.',
  '  get_user: { path: "/users/${id}", auth: bearer }',
  ''
].join('\n');
const apiBlocks = [
  { kind: 'key', name: 'base_url', start: { line: 2, column: 1 }, end: { line: 2, column: 21 } },
  { kind: 'key', name: 'auth', start: { line: 3, column: 1 }, end: { line: 5, column: 37 } },
  { kind: 'auth', name: 'bearer', start: { line: 4, column: 3 }, end: { line: 5, column: 37 } },
  { kind: 'key', name: 'endpoints', start: { line: 7, column: 1 }, end: { line: 12, column: 51 } },
  { kind: 'endpoint', name: 'login', start: { line: 8, column: 3 }, end: { line: 10, column: 17 } },
  { kind: 'endpoint', name: 'get_user', start: { line: 12, column: 3 }, end: { line: 12, column: 51 } }
];
const block = name => apiBlocks.find(b => b.name === name && b.kind !== 'key');

test('a block is replaced by whole lines; the comments around it stay', () => {
  const result = editor.replaceBlock(api, block('login'), '  login:\n    method: POST\n    path: /sign-in\n');
  assert.equal(result.split('\n').slice(6, 11).join('\n'), [
    'endpoints:',
    '  login:',
    '    method: POST',
    '    path: /sign-in',
    '  # Users by id.'
  ].join('\n'));
});

test('a block is removed with its lines, and a block is added after another', () => {
  assert.ok(!editor.removeBlock(api, block('get_user')).includes('get_user'));
  assert.ok(editor.removeBlock(api, block('get_user')).endsWith('  # Users by id.\n'));
  const added = editor.insertAfter(api, block('get_user'), '  ping:\n    path: /ping\n');
  assert.ok(added.endsWith('  get_user: { path: "/users/${id}", auth: bearer }\n  ping:\n    path: /ping\n'));
});

test('two blocks are swapped, with what is between them kept', () => {
  const text = 'steps:\n  - call: a\n  # between\n  - call: b\n    with: { x: 1 }\n';
  const a = { start: { line: 2, column: 3 }, end: { line: 2, column: 12 } };
  const b = { start: { line: 4, column: 3 }, end: { line: 5, column: 19 } };
  assert.equal(editor.swapBlocks(text, a, b), 'steps:\n  - call: b\n    with: { x: 1 }\n  # between\n  - call: a\n');
});

test('Windows line endings are kept', () => {
  const text = 'endpoints:\r\n  a:\r\n    path: /a\r\n';
  const a = { start: { line: 2, column: 3 }, end: { line: 3, column: 13 } };
  assert.equal(editor.replaceBlock(text, a, '  a:\n    path: /b\n'), 'endpoints:\r\n  a:\r\n    path: /b\r\n');
});

test('an auth set is added after the others, or in a new auth: before the endpoints', () => {
  const after = editor.addAuthSet(api, apiBlocks, { name: 'key', kind: 'header', header: 'X-Api-Key', value: '${apiKey}' });
  assert.ok(after.includes('    Authorization: "Bearer ${token}"\n  key:\n    X-Api-Key: ${apiKey}\n\nendpoints:'));
  const text = 'base_url: x\nendpoints:\n  a: { path: /a }\n';
  const blocks = [{ kind: 'key', name: 'endpoints', start: { line: 2, column: 1 }, end: { line: 3, column: 18 } }];
  assert.equal(editor.addAuthSet(text, blocks, { name: 'service', kind: 'basic', username: 'admin', password: '${password}' }),
    'base_url: x\nauth:\n  service:\n    basic:\n      username: admin\n      password: ${password}\nendpoints:\n  a: { path: /a }\n');
});

test('auth sets are read back into the form, or said to need YAML', () => {
  assert.deepEqual(editor.authFromSource('bearer', { Authorization: 'Bearer ${token}' }), { name: 'bearer', kind: 'bearer', token: '${token}' });
  assert.deepEqual(editor.authFromSource('key', { 'X-Api-Key': '${apiKey}' }), { name: 'key', kind: 'header', header: 'X-Api-Key', value: '${apiKey}' });
  assert.deepEqual(editor.authFromSource('svc', { basic: { username: 'admin', password: 42 } }), { name: 'svc', kind: 'basic', username: 'admin', password: '42' });
  assert.equal(editor.authFromSource('o', { oauth2: { token_url: 'x', client_id: 'a', client_secret: 'b', scope: ['r', 'w'] } }).scope, 'r w');
  assert.deepEqual(editor.authFromSource('two', { A: '1', B: '2' }), { unsupported: ['several headers in one auth set'] });
});

test('an endpoint is read back into the form; form and multipart bodies need YAML', () => {
  const form = editor.requestFromSource('get_user', { path: '/users/${id}', auth: 'bearer', query: ['fields'], headers: { 'X-Client': 'app', 'X-Version': 2 }, params: { id: 1, fields: '42' } });
  assert.deepEqual(form, {
    name: 'get_user', method: 'GET', path: '/users/${id}', auth: 'bearer', query: 'fields',
    headers: [{ name: 'X-Client', value: 'app' }, { name: 'X-Version', value: '2' }],
    body: '', defaults: [{ name: 'id', value: '1' }, { name: 'fields', value: '"42"' }]
  });
  assert.deepEqual(editor.requestFromSource('up', { path: '/u', multipart: { a: 1 } }), { unsupported: ['a multipart body'] });
});

const step = {
  kind: 'call',
  name: 'Create a user',
  call: 'create_user',
  with: [{ name: 'email', value: 'ada@example.com' }, { name: 'age', value: '36' }, { name: 'code', value: '"007"' }, { name: 'skip', value: '' }],
  status: '201, 200',
  checks: [
    { path: '$.id', op: 'exists', value: 'true' },
    { path: '$.id', op: 'gt', value: '0' },
    { path: '$.role', op: 'in', value: 'admin, owner' },
    { path: '$.email', op: 'eq', value: 'ada@example.com' },
    { path: '$.ref', op: 'matches', value: '^U-[0-9]+$' }
  ],
  saves: [{ name: 'userId', path: '$.id' }]
};

test('a step is written as YAML, several operators on one path in one mapping', () => {
  assert.equal(editor.stepYaml(step, 2), [
    '  - name: Create a user',
    '    call: create_user',
    '    with:',
    '      email: ada@example.com',
    '      age: 36',
    '      code: "007"',
    '    expect:',
    '      status: [201, 200]',
    '      body:',
    '        $.id: { exists: true, gt: 0 }',
    '        $.role: { in: ["admin", "owner"] }',
    '        $.email: ada@example.com',
    '        $.ref: { matches: "^U-[0-9]+$" }',
    '    save:',
    '      userId: $.id',
    ''
  ].join('\n'));
  assert.equal(editor.stepYaml({ kind: 'sleep', sleep: '2s' }, 2), '  - sleep: 2s\n');
});

test('what the form cannot show is edited as YAML', () => {
  assert.deepEqual(editor.stepFromSource({ use: 'log-in.yaml' }), { unsupported: ['use'] });
  assert.deepEqual(editor.stepFromSource({ call: 'a', until: {}, expect: { headers: {} } }), { unsupported: ['until', 'checks on headers'] });
  assert.deepEqual(editor.stepFromSource({ call: 'a', expect: { body: { $: { schema: 'x.json' } } } }), { unsupported: ['schema checks'] });
  assert.deepEqual(editor.stepFromSource({ call: 'a', save: { csrf: { cookie: 'XSRF' } } }), { unsupported: ['saving a cookie'] });
  assert.deepEqual(editor.stepFromSource({ sleep: '1s' }), { kind: 'sleep', sleep: '1s' });
});

test('a new workflow has its imports and its first step', () => {
  assert.equal(editor.newWorkflowFile({ name: 'Smoke', imports: ['../api/shop.yaml'], step: { kind: 'call', call: 'ping' } }),
    'name: Smoke\nimport:\n  - ../api/shop.yaml\nsteps:\n  - call: ping\n');
  assert.equal(editor.workflowFileName('Smoke test!'), 'workflows/smoke-test.yaml');
  assert.equal(editor.relativePath('workflows/smoke.yaml', 'api/shop.yaml'), '../api/shop.yaml');
  assert.equal(editor.relativePath('smoke.yaml', 'api/shop.yaml'), 'api/shop.yaml');
  assert.equal(editor.relativePath('a/b/w.yaml', 'a/api.yaml'), '../api.yaml');
});

// The round trip through the real tinyprobe: what the form writes is read back by `inspect --source` into the
// same form. Runs when TINYPROBE_PATH names a tinyprobe with --source (0.21.0, or a development build).
const withSource = (() => {
  try {
    return Boolean(process.env.TINYPROBE_PATH) && execFileSync(process.env.TINYPROBE_PATH, ['--help']).toString().includes('--source');
  } catch {
    return false;
  }
})();

test('a step written by the form is read back by tinyprobe into the same form', { skip: !withSource }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyprobe-editor-'));
  fs.writeFileSync(path.join(folder, 'api.yaml'), 'base_url: http://localhost/\nendpoints:\n  create_user:\n    method: POST\n    path: /users\n    body: { email: "${email}", age: "${age}", code: "${code}" }\n');
  fs.writeFileSync(path.join(folder, 'w.yaml'), editor.newWorkflowFile({ name: 'W', imports: ['api.yaml'], step }));
  const json = JSON.parse(execFileSync(process.env.TINYPROBE_PATH, ['inspect', 'w.yaml', '--json', '--source'], { cwd: folder }).toString());
  assert.equal(json.valid, true, JSON.stringify(json.errors));
  const back = editor.stepFromSource(json.source.steps[0]);
  assert.equal(editor.stepYaml(back, 2), editor.stepYaml(step, 2));
  fs.rmSync(folder, { recursive: true });
});
