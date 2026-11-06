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

test('what the form does not show comes back as YAML, under the keys of the step', () => {
  assert.deepEqual(editor.stepFromSource({ sleep: '1s' }), { kind: 'sleep', sleep: '1s' });
  const form = editor.stepFromSource({
    name: 'Wait for the report',
    call: 'get_report',
    with: { id: '${reportId}', note: '', tags: ['a', 'b'] },
    until: { every: '1s', timeout: '30s' },
    expect: {
      status: 200,
      headers: { 'Content-Type': { contains: 'json' }, 'X-Mode': { any: ['a', { matches: '^b' }] } },
      cookies: { sid: { exists: true } },
      body: { '$.state': 'done', '$.owner': null, '$': { schema: 'report.json' } },
      duration: { lt: '500ms' }
    },
    save: { csrf: { cookie: 'XSRF' }, url: '$.url' }
  });
  assert.deepEqual(form.with, [{ name: 'id', value: '${reportId}' }, { name: 'note', value: '""' }]);
  assert.deepEqual(form.checks, [
    { on: 'body', path: '$.state', op: 'eq', value: 'done' },
    { on: 'body', path: '$.owner', op: 'eq', value: 'null' },
    { on: 'header', path: 'Content-Type', op: 'contains', value: 'json' },
    { on: 'cookie', path: 'sid', op: 'exists', value: 'true' },
    { on: 'duration', path: '', op: 'lt', value: '500ms' }
  ]);
  assert.deepEqual(form.saves, [{ name: 'url', path: '$.url' }]);
  assert.deepEqual(form.until, { every: '1s', timeout: '30s', status: '', checks: [] });
  assert.equal(form.extra, [
    'with:',
    '  tags:',
    '    - a',
    '    - b',
    'expect:',
    '  body:',
    '    $:',
    '      schema: report.json',
    '  headers:',
    '    X-Mode:',
    '      any:',
    '        - a',
    '        - matches: ^b',
    'save:',
    '  csrf:',
    '    cookie: XSRF',
    ''
  ].join('\n'));
  assert.equal(editor.stepYaml(form, 2), [
    '  - name: Wait for the report',
    '    call: get_report',
    '    with:',
    '      id: ${reportId}',
    '      note: ""',
    '      tags:',
    '        - a',
    '        - b',
    '    until:',
    '      every: 1s',
    '      timeout: 30s',
    '    expect:',
    '      status: 200',
    '      headers:',
    '        Content-Type: { contains: "json" }',
    '        X-Mode:',
    '          any:',
    '            - a',
    '            - matches: ^b',
    '      cookies:',
    '        sid: { exists: true }',
    '      body:',
    '        $.state: done',
    '        $.owner: null',
    '        $:',
    '          schema: report.json',
    '      duration: { lt: 500ms }',
    '    save:',
    '      url: $.url',
    '      csrf:',
    '        cookie: XSRF',
    ''
  ].join('\n'));
});

test('a use step runs a sequence with its params, the rest as YAML', () => {
  const form = editor.stepFromSource({ name: 'Admin', use: '../sequences/log-in.yaml', with: { password: 'secret', roles: ['admin'] } });
  assert.deepEqual(form, {
    kind: 'use', name: 'Admin', use: '../sequences/log-in.yaml',
    with: [{ name: 'password', value: 'secret' }],
    extra: 'with:\n  roles:\n    - admin\n'
  });
  assert.equal(editor.stepYaml(form, 2), '  - name: Admin\n    use: ../sequences/log-in.yaml\n    with:\n      password: secret\n      roles:\n        - admin\n');
  assert.equal(editor.stepYaml({ kind: 'use', use: 'log-in.yaml', with: [{ name: 'user', value: '' }] }, 2), '  - use: log-in.yaml\n');
  assert.throws(() => editor.stepYaml({ kind: 'use', use: 'log-in.yaml', extra: 'save:\n  x: $.id\n' }, 2), /A use step has no expect or save/);
  assert.deepEqual(editor.stepFromSource({ with: { a: 1 } }), { unsupported: ['no call'] });
  assert.equal(editor.resolvePath('workflows/smoke.yaml', '../sequences/log-in.yaml'), 'sequences/log-in.yaml');
  assert.equal(editor.resolvePath('smoke.yaml', './log-in.yaml'), 'log-in.yaml');
});

test('for_each and until are in the form when all of them is', () => {
  const step = {
    name: 'Cases', call: 'status',
    for_each: [{ code: 200, note: ' padded ' }, { code: 404, note: '' }, { code: 503 }],
    until: { status: 200, body: { '$.state': { in: ['done', 'failed'] } }, every: '100ms', timeout: '5s' },
    expect: { status: '${code}' }
  };
  const form = editor.stepFromSource(step);
  assert.deepEqual(form.forEach, {
    kind: 'list', columns: ['code', 'note'],
    items: [{ code: '200', note: '" padded "' }, { code: '404', note: '""' }, { code: '503' }]
  });
  assert.deepEqual(form.until, { every: '100ms', timeout: '5s', status: '200', checks: [{ on: 'body', path: '$.state', op: 'in', value: 'done, failed' }] });
  assert.equal(form.extra, '');
  assert.equal(editor.stepYaml(form, 2), [
    '  - name: Cases',
    '    call: status',
    '    for_each:',
    '      - { code: 200, note: " padded " }',
    '      - { code: 404, note: "" }',
    '      - { code: 503 }',
    '    until:',
    '      status: 200',
    '      body:',
    '        $.state: { in: ["done", "failed"] }',
    '      every: 100ms',
    '      timeout: 5s',
    '    expect:',
    '      status: ${code}',
    ''
  ].join('\n'));
  assert.deepEqual(editor.stepFromSource({ call: 'a', for_each: '${users}' }).forEach, { kind: 'variable', value: '${users}' });
  assert.deepEqual(editor.stepFromSource({ call: 'a', for_each: { file: 'cases.csv' } }).forEach, { kind: 'file', file: 'cases.csv' });
  assert.equal(editor.stepYaml({ kind: 'call', call: 'a', forEach: { kind: 'variable', value: 'users' } }, 0), '- call: a\n  for_each: ${users}\n');
  assert.equal(editor.stepYaml({ kind: 'call', call: 'a', forEach: { kind: 'file', file: 'cases.csv' } }, 0), '- call: a\n  for_each: { file: "cases.csv" }\n');
  // Items with an object, or an until with a schema check, stay YAML whole.
  const typed = editor.stepFromSource({ call: 'a', for_each: [{ user: { id: 1 } }], until: { body: { $: { schema: 'x.json' } } } });
  assert.equal(typed.forEach, null);
  assert.equal(typed.until, null);
  assert.equal(typed.extra, 'for_each:\n  - user:\n      id: 1\nuntil:\n  body:\n    $:\n      schema: x.json\n');
});

test('checks on headers, cookies and duration are written under their keys', () => {
  const step = {
    kind: 'call', call: 'ping',
    checks: [
      { on: 'header', path: 'Content-Type', op: 'eq', value: 'application/json' },
      { on: 'header', path: 'Cache-Control', op: 'contains', value: 'no-store' },
      { on: 'cookie', path: 'sid', op: 'exists', value: 'false' },
      { on: 'duration', path: '', op: 'gte', value: '10ms' },
      { on: 'duration', path: '', op: 'lt', value: '2s' },
      { on: 'duration', path: '', op: 'lt', value: '' },
      { on: 'header', path: '', op: 'eq', value: 'x' }
    ]
  };
  assert.equal(editor.stepYaml(step, 2), [
    '  - call: ping',
    '    expect:',
    '      headers:',
    '        Content-Type: application/json',
    '        Cache-Control: { contains: "no-store" }',
    '      cookies:',
    '        sid: { exists: false }',
    '      duration: { gte: 10ms, lt: 2s }',
    ''
  ].join('\n'));
});

test('YAML typed by hand goes where its keys say, its comments and indentation kept', () => {
  const step = { kind: 'call', call: 'ping', status: '200', extra: '  # poll it\n  until:\n      every: 1s\n  expect:\n      duration: { lt: 500ms }\n' };
  assert.equal(editor.stepYaml(step, 2), '  - call: ping\n    # poll it\n    until:\n        every: 1s\n    expect:\n      status: 200\n      duration: { lt: 500ms }\n');
  assert.throws(() => editor.stepYaml({ ...step, extra: 'expect: { headers: {} }' }), /Write expect: with one key per line/);
  assert.throws(() => editor.stepYaml({ ...step, extra: 'name: x' }), /set in the form above/);
  assert.throws(() => editor.extraParts('- until'), /Line 1 of the YAML is not a key/);
  assert.deepEqual(editor.extraParts(' \n'), { step: [], with: [], expect: [], body: [], headers: [], cookies: [], save: [] });
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
  assert.equal(editor.stepYaml(back, 2), editor.stepYaml({ ...step, extra: '' }, 2));
  fs.rmSync(folder, { recursive: true });
});

test('a copy of a workflow gets its new name, next to the original, the rest as it was', () => {
  const text = '# Users and their roles\nname: Users\ndescription: All of them\nimport: [../api/users.yaml]\nsteps:\n  - call: list_users   # first\n';
  assert.equal(editor.renamedWorkflow(text, 'Users: admins only'),
    '# Users and their roles\nname: "Users: admins only"\ndescription: All of them\nimport: [../api/users.yaml]\nsteps:\n  - call: list_users   # first\n');
  assert.equal(editor.renamedWorkflow('name: >\n  A long\n  name\nsteps: []\n', 'Short'), 'name: Short\nsteps: []\n');
  assert.equal(editor.renamedWorkflow('steps:\n  - call: ping\n', 'Ping'), 'name: Ping\nsteps:\n  - call: ping\n');
  assert.equal(editor.renamedWorkflow('steps:\r\n  - call: ping\r\n', 'Ping'), 'name: Ping\r\nsteps:\r\n  - call: ping\r\n');
  // A step's own name is not the workflow's.
  assert.equal(editor.renamedWorkflow('steps:\n  - name: Log in\n    call: login\n', 'X'), 'name: X\nsteps:\n  - name: Log in\n    call: login\n');
  assert.equal(editor.copyFileName('tinyprobe/workflows/users.yaml', 'Users (copy)'), 'tinyprobe/workflows/users-copy.yaml');
  assert.equal(editor.copyFileName('smoke.yaml', 'Smoke 2'), 'smoke-2.yaml');
  assert.equal(editor.copyFileName('workflows/a.yaml', '  !! '), null);
});

// Blocks as tinyprobe 0.23.0 gives them for these files: a block ending in a multi-line text ends at the start of
// the next line.
test('a step ending in a multi-line text is replaced, moved and removed without the next one', () => {
  const text = 'steps:\n  - call: ping\n    with:\n      note: |\n        a\n        b\n\n  - call: pong\n';
  const first = { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 8, column: 1 } };
  const second = { kind: 'step', index: 1, start: { line: 8, column: 3 }, end: { line: 8, column: 15 } };
  assert.equal(editor.removeBlock(text, first), 'steps:\n\n  - call: pong\n');
  assert.equal(editor.replaceBlock(text, first, '  - call: other'), 'steps:\n  - call: other\n\n  - call: pong\n');
  assert.equal(editor.swapBlocks(text, first, second), 'steps:\n  - call: pong\n\n  - call: ping\n    with:\n      note: |\n        a\n        b\n');
  // At the end of the file.
  const last = 'steps:\n  - call: ping\n    with:\n      note: |\n        a\n';
  assert.equal(editor.removeBlock(last, { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 6, column: 1 } }), 'steps:\n');
});

test('the name and the description of a workflow change where they are written', () => {
  const text = '# yaml-language-server: $schema=x\nname: W   # the name\ndescription: >\n  Two\n  lines\nimport: [api.yaml]\nsteps:\n  - call: ping\n';
  const blocks = [
    { kind: 'key', name: 'name', start: { line: 2, column: 1 }, end: { line: 2, column: 8 } },
    { kind: 'key', name: 'description', start: { line: 3, column: 1 }, end: { line: 6, column: 1 } },
    { kind: 'key', name: 'import', start: { line: 6, column: 1 }, end: { line: 6, column: 19 } }
  ];
  assert.equal(editor.workflowHead(text, blocks, { name: 'Users: admins', description: 'One line' }),
    '# yaml-language-server: $schema=x\nname: "Users: admins"\ndescription: One line\nimport: [api.yaml]\nsteps:\n  - call: ping\n');
  assert.equal(editor.workflowHead(text, blocks, { name: 'W2', description: '  ' }),
    '# yaml-language-server: $schema=x\nname: W2\nimport: [api.yaml]\nsteps:\n  - call: ping\n');
  // A description added after the name; both added on top, under the leading comments.
  assert.equal(editor.workflowHead('name: W\nsteps: []\n', [{ kind: 'key', name: 'name', start: { line: 1, column: 1 }, end: { line: 1, column: 8 } }], { name: 'W', description: 'Why' }),
    'name: W\ndescription: Why\nsteps: []\n');
  assert.equal(editor.workflowHead('# c\r\nsteps: []\r\n', [], { name: 'New', description: 'Why' }), '# c\r\nname: New\r\ndescription: Why\r\nsteps: []\r\n');
  assert.equal(editor.workflowHead('steps: []\n', [], { name: 'New', description: '' }), 'name: New\nsteps: []\n');
});

test('a copied step comes right after it, with (copy) in its own name only', () => {
  const text = 'steps:\n  - name: "Ping: one"   # first\n    call: ping\n    with: { name: inner }\n  - call: ping\n';
  const first = { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 4, column: 26 } };
  assert.equal(editor.duplicateStep(text, first),
    'steps:\n  - name: "Ping: one"   # first\n    call: ping\n    with: { name: inner }\n  - name: "Ping: one (copy)"\n    call: ping\n    with: { name: inner }\n  - call: ping\n');
  const named = 'steps:\r\n  - call: ping\r\n    name: Ping\r\n';
  assert.equal(editor.duplicateStep(named, { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 3, column: 15 } }),
    'steps:\r\n  - call: ping\r\n    name: Ping\r\n  - call: ping\r\n    name: Ping (copy)\r\n');
  // Without a name of its own, the copy is the same step; a nested name stays.
  const nested = 'steps:\n  - call: ping\n    with:\n      name: x\n';
  assert.equal(editor.duplicateStep(nested, { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 4, column: 14 } }),
    nested + '  - call: ping\n    with:\n      name: x\n');
  // An empty line after the step: one before the copy too.
  assert.equal(editor.duplicateStep('steps:\n  - call: a\n\n  - call: b\n', { kind: 'step', index: 0, start: { line: 2, column: 3 }, end: { line: 2, column: 12 } }),
    'steps:\n  - call: a\n\n  - call: a\n\n  - call: b\n');
  assert.equal(editor.stepAt([{ kind: 'key', name: 'steps', start: { line: 1, column: 1 }, end: { line: 4, column: 14 } }, first, { kind: 'step', index: 1, start: { line: 5, column: 3 }, end: { line: 5, column: 15 } }], 5), 1);
});
