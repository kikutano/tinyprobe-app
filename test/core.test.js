'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../web/lib/core.js');

test('LineSplitter joins events cut by the network and skips empty lines', () => {
  const lines = [];
  const splitter = new core.LineSplitter(line => lines.push(line));
  splitter.push('{"event":"run_st');
  splitter.push('arted"}\n\n{"event":"step_started"}\r\n{"app":');
  splitter.push('"exit"}');
  splitter.end();
  assert.deepEqual(lines, ['{"event":"run_started"}', '{"event":"step_started"}', '{"app":"exit"}']);
});

test('topLevelKeys lists the variables of an environment file, not nested keys or comments', () => {
  const text = '# local\nbaseUrl: http://localhost:8080/\ntoken: "abc"\nnested:\n  inner: 1\n#commented: 2\nempty:\n';
  assert.deepEqual(core.topLevelKeys(text), ['baseUrl', 'token', 'nested', 'empty']);
});

test('childKeys lists the auth sets of an API file', () => {
  const text = 'base_url: x\nauth:\n  bearer:\n    Authorization: "Bearer ${token}"\n  # a comment\n  service:\n    basic: { username: a, password: b }\nendpoints:\n  ping: { path: /ping }\n';
  assert.deepEqual(core.childKeys(text, 'auth'), ['bearer', 'service']);
  assert.deepEqual(core.childKeys(text, 'endpoints'), ['ping']);
  assert.deepEqual(core.childKeys(text, 'missing'), []);
});

test('placeholders are found once each, in order, without generated values', () => {
  assert.deepEqual(core.placeholders('/users/${id}/orders/${orderId}', '{"x":"${id}","y":"${$uuid}"}', null), ['id', 'orderId']);
});

test('checkName accepts what call: can name, and refuses the rest with a message', () => {
  assert.equal(core.checkName('get_user', ['list_users']), null);
  assert.equal(core.checkName('get user', []), "The name 'get user' is not valid: use letters, digits and _, e.g. get_user");
  assert.equal(core.checkName('billing.login', []), "The name 'billing.login' is not valid: use letters, digits and _, e.g. get_user");
  assert.equal(core.checkName('get_user', ['get_user']), "This file already has an endpoint 'get_user'");
});

test('scalar quotes only what YAML would read differently', () => {
  assert.equal(core.scalar('/users/${id}'), '/users/${id}');
  assert.equal(core.scalar('Bearer ${token}'), 'Bearer ${token}');
  assert.equal(core.scalar('42'), '"42"');
  assert.equal(core.scalar('true'), '"true"');
  assert.equal(core.scalar('no'), '"no"');
  assert.equal(core.scalar(''), '""');
  assert.equal(core.scalar('a: b'), '"a: b"');
  assert.equal(core.scalar('#tag'), '"#tag"');
  assert.equal(core.scalar('{x}'), '"{x}"');
  assert.equal(core.scalar(' padded'), '" padded"');
  assert.equal(core.scalar('line\nbreak'), '"line\\nbreak"');
});

test('typed keeps numbers, booleans and quoted strings as written, like --with', () => {
  assert.equal(core.typed('1'), '1');
  assert.equal(core.typed('2.5'), '2.5');
  assert.equal(core.typed('true'), 'true');
  assert.equal(core.typed('"42"'), '"42"');
  assert.equal(core.typed('007'), '"007"');
  assert.equal(core.typed('ada@example.com'), 'ada@example.com');
});

test('toYaml writes a JSON body as block YAML, keeping types', () => {
  const yaml = core.toYaml({ title: '${title}', userId: 1, tags: ['a', 'b'], items: [{ sku: 'X', qty: 2 }], draft: false, note: null, empty: {} }, 2);
  assert.equal(yaml, [
    '',
    '  title: ${title}',
    '  userId: 1',
    '  tags:',
    '    - a',
    '    - b',
    '  items:',
    '    - sku: X',
    '      qty: 2',
    '  draft: false',
    '  note: null',
    '  empty: {}'
  ].join('\n'));
});

const request = {
  name: 'create_post',
  method: 'post',
  path: '/posts',
  auth: 'bearer',
  query: ['notify', ' ', 'page'],
  headers: [{ name: 'X-Client', value: 'tinyprobe-app' }],
  body: '{"title": "${title}", "userId": 1}',
  defaults: [{ name: 'title', value: 'hello' }, { name: 'page', value: '1' }]
};

test('endpointYaml writes the fields that are filled, GET without a method', () => {
  assert.equal(core.endpointYaml(request, 2), [
    '  create_post:',
    '    method: POST',
    '    path: /posts',
    '    auth: bearer',
    '    params:',
    '      title: hello',
    '      page: 1',
    '    query: [notify, page]',
    '    headers:',
    '      X-Client: tinyprobe-app',
    '    body:',
    '      title: ${title}',
    '      userId: 1',
    ''
  ].join('\n'));
  assert.equal(core.endpointYaml({ name: 'ping', method: 'GET', path: '/ping' }, 2), '  ping:\n    path: /ping\n');
});

test('a param with an empty default is written as required', () => {
  assert.match(core.endpointYaml({ name: 'get_user', path: '/users/${id}', defaults: [{ name: 'id', value: '' }] }, 2), /\n    params:\n      id:\n/);
});

test('addEndpoint appends to the endpoints of a file, keeping its comments, order and indentation', () => {
  const text = [
    '# Shop API',
    'base_url: ${baseUrl}',
    'endpoints:',
    '    list: { path: /items }   # four spaces in this file',
    '',
    '    # the next one is old',
    '    get: { path: /items/${id} }',
    '',
    'auth:',
    '    bearer: { Authorization: "Bearer ${token}" }',
    ''
  ].join('\n');
  const { text: result, error } = core.addEndpoint(text, { name: 'ping', path: '/ping' });
  assert.equal(error, undefined);
  assert.equal(result, [
    '# Shop API',
    'base_url: ${baseUrl}',
    'endpoints:',
    '    list: { path: /items }   # four spaces in this file',
    '',
    '    # the next one is old',
    '    get: { path: /items/${id} }',
    '    ping:',
    '        path: /ping',
    '',
    'auth:',
    '    bearer: { Authorization: "Bearer ${token}" }',
    ''
  ].join('\n'));
});

test('addEndpoint keeps Windows line endings', () => {
  const { text } = core.addEndpoint('base_url: x\r\nendpoints:\r\n  a: { path: /a }\r\n', { name: 'b', path: '/b' });
  assert.equal(text, 'base_url: x\r\nendpoints:\r\n  a: { path: /a }\r\n  b:\r\n    path: /b\r\n');
});

test('addEndpoint adds endpoints: to a file without it, and refuses one written on one line', () => {
  assert.equal(core.addEndpoint('base_url: x\n', { name: 'a', path: '/a' }).text, 'base_url: x\nendpoints:\n  a:\n    path: /a\n');
  assert.equal(core.addEndpoint('endpoints: {}\n', { name: 'a', path: '/a' }).error, 'This file writes its endpoints on one line: add the request in an editor.');
});

test('addEndpoint reports a body that is not JSON', () => {
  assert.match(core.addEndpoint('endpoints:\n', { name: 'a', path: '/a', body: '{title: x' }).error, /^The body is not valid JSON: /);
});

test('newApiFile starts a file with its base URL', () => {
  assert.equal(core.newApiFile('https://api.example.com', { name: 'ping', path: '/ping' }).text,
    '# API file created by tinyprobe-app. Edit it in any editor: it runs with tinyprobe in a terminal and in CI.\nbase_url: https://api.example.com\nendpoints:\n  ping:\n    path: /ping\n');
  assert.match(core.newApiFile('', { name: 'ping', path: '/ping' }).text, /\nbase_url: \$\{baseUrl\}\n/);
});

test('apiFileName makes a file name from what the user typed', () => {
  assert.equal(core.apiFileName('Shop API'), 'api/shop-api.yaml');
  assert.equal(core.apiFileName('  '), null);
});
