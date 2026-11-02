'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { flowModel, valueLines, laneColumns, laneColors } = require('../web/shared/flow.js');

// An inspect --json document as tinyprobe writes it, with the keys the flow reads.
const inspect = {
  variables: [{ name: 'reportName', value: 'Daily' }],
  endpoints: [
    { name: 'login', method: 'POST', path: '/login', query: [], params: [{ name: 'username', required: false, default: 'admin' }], arguments: ['baseUrl', 'username', 'password'] },
    { name: 'get_user', method: 'GET', path: '/users/${id}', query: ['fields'], params: [], arguments: ['baseUrl', 'fields', 'id', 'token'] },
    { name: 'create_user', method: 'POST', path: '/users', query: [], params: [], arguments: ['baseUrl', 'name', 'token'] },
    { name: 'report', method: 'POST', path: '/reports', query: [], params: [], arguments: ['baseUrl', 'reportName', 'token'] }
  ],
  steps: [
    { index: 0, type: 'call', name: 'Log in', call: 'login', with: { password: '${password}' }, save: { token: '$.token' }, sequence: { name: 'Log in', file: '/w/sequences/log-in.yaml' }, for_each: null, until: null },
    { index: 1, type: 'call', name: 'Create', call: 'create_user', with: { name: 'Ada' }, save: { userId: '$.id' }, sequence: null, for_each: null, until: null },
    { index: 2, type: 'sleep', name: 'sleep 1s', duration_ms: 1000 },
    { index: 3, type: 'call', name: 'Read it', call: 'get_user', with: { id: '${userId}' }, save: {}, sequence: null, for_each: null, until: { every_ms: 500, timeout_ms: 5000 } },
    { index: 4, type: 'call', name: 'Each', call: 'get_user', with: {}, save: {}, sequence: null, for_each: { items: [{ id: 1 }, { id: 2 }], variable: null, file: null }, until: null },
    { index: 5, type: 'call', name: 'Report', call: 'report', with: {}, save: { token: '$.next' }, sequence: null, for_each: null, until: null },
    { index: 6, type: 'call', name: 'Missing', call: 'get_user', with: { id: '${nobody}' }, save: {}, sequence: null, for_each: null, until: null }
  ]
};

test('a saved value is a lane from the step that saves it to the steps that use it; saved again, a new lane', () => {
  const model = flowModel(inspect, ['baseUrl']);

  assert.deepEqual(model.lanes.map(l => [l.name, l.from, l.to]), [
    ['token', 0, [1, 3, 4, 5]],
    ['userId', 1, [3]],
    ['token', 5, [6]]
  ]);
  assert.deepEqual(model.nodes[3].uses.map(u => u.name), ['userId', 'token']);
  assert.deepEqual(model.nodes[1].saves, [{ name: 'userId', lane: 1, unused: false }]);
});

test('values from elsewhere are listed by where they come from', () => {
  const model = flowModel(inspect, ['baseUrl']);

  assert.deepEqual(model.inputs, { environment: ['baseUrl'], variables: ['reportName'], other: ['nobody'] });
});

test('optional values are not needed: query parameters and params with a default', () => {
  const model = flowModel(inspect, ['baseUrl']);

  assert.ok(!model.nodes[3].uses.some(u => u.name === 'fields'));
  assert.ok(!model.inputs.other.includes('username'));
});

test('the params of a sequence and the keys of for_each items come from the step itself', () => {
  const model = flowModel(inspect, ['baseUrl']);

  assert.ok(!model.inputs.other.includes('password'));
  assert.ok(!model.inputs.other.includes('id'));
  assert.equal(model.nodes[0].sequence, 'Log in');
});

test('nodes describe the call, sleep, until and for_each', () => {
  const [login, , sleep, read, each] = flowModel(inspect, []).nodes;

  assert.deepEqual([login.method, login.path, login.call], ['POST', '/login', 'login']);
  assert.deepEqual([sleep.type, sleep.duration], ['sleep', 1000]);
  assert.deepEqual(read.until, { every: 500, timeout: 5000 });
  assert.equal(each.forEach, 2);
});

test('a value saved and never used afterwards is marked, and gets no line', () => {
  const model = flowModel({
    endpoints: [{ name: 'login', method: 'POST', path: '/login', query: [], params: [], arguments: [] }],
    steps: [{ index: 0, type: 'call', name: 'Log in', call: 'login', with: {}, save: { token: '$.token' }, sequence: null, for_each: null, until: null }]
  }, []);

  assert.deepEqual(model.nodes[0].saves, [{ name: 'token', lane: 0, unused: true }]);
  assert.equal(laneColumns(model.lanes).size, 0);
});

test('values wrap inside the node, uses and saves on lines of their own', () => {
  const node = {
    uses: ['token', 'userId', 'orderId', 'customerId', 'invoiceNumber'].map((name, lane) => ({ name, lane })),
    saves: [{ name: 'receiptId', lane: 9, unused: true }]
  };

  const lines = valueLines(node, 40);

  assert.deepEqual(lines.map(l => [l.label, l.items.map(i => i.text).join('')]), [
    ['uses', ' ● token, ● userId, ● orderId,'],
    ['', ' ● customerId, ● invoiceNumber'],
    ['saves', ' ● receiptId (not used)']
  ]);
  assert.ok(lines.every(l => l.length <= 40));
  assert.equal(lines[2].items[0].unused, true);
});

test('lanes share a column once the one before has ended', () => {
  const lanes = [
    { id: 0, from: 0, to: [1, 5] },
    { id: 1, from: 1, to: [2] },
    { id: 2, from: 3, to: [4] },
    { id: 3, from: 4, to: [] },
    { id: 4, from: 5, to: [6] }
  ];

  assert.deepEqual([...laneColumns(lanes)], [[0, 0], [1, 1], [2, 1], [4, 1]]);
});

test('lanes drawn at the same time never share a color', () => {
  const lanes = [
    { id: 0, from: 0, to: [6] },
    { id: 1, from: 1, to: [4] },
    { id: 2, from: 1, to: [4] },
    { id: 3, from: 1, to: [4] },
    { id: 4, from: 1, to: [4] },
    { id: 5, from: 1, to: [4] },
    { id: 6, from: 2, to: [5] },
    { id: 7, from: 5, to: [6] }
  ];
  const colors = laneColors(lanes, laneColumns(lanes));

  assert.deepEqual([0, 1, 2, 3, 4, 5].map(id => colors.get(id)), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set([0, 1, 2, 3, 4, 5, 6].map(id => colors.get(id))).size, 7);
  assert.notEqual(colors.get(7), colors.get(0));
});
