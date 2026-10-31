'use strict';

// The history shared with the VS Code extension (web/shared/history.js); these tests come from its protocol tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../web/shared/history.js');

test('a history entry sums up a call from its events, with long bodies cut', () => {
  const completed = {
    event: 'step_completed', index: 0, name: 'get_user id=1', success: true, failure: null,
    method: 'GET', url: 'http://localhost:5122/api/users/1', status: 200, duration_ms: 12.5,
    request: { method: 'GET', url: 'http://localhost:5122/api/users/1', headers: [], body: null },
    response: { status: 200, reason: 'OK', headers: [], body: 'x'.repeat(10), body_truncated: false }
  };
  const events = [{ event: 'run_started' }, completed, { event: 'run_finished', success: true }];
  const entry = protocol.historyEntry({ file: '/w/api.yaml', endpoint: 'get_user', args: [['id', '1']], environment: '/w/env.yaml', events, time: 5 }, 4);

  assert.deepEqual({ ...entry, events: undefined }, {
    time: 5, file: '/w/api.yaml', endpoint: 'get_user', args: [['id', '1']], environment: '/w/env.yaml',
    method: 'GET', url: 'http://localhost:5122/api/users/1', status: 200, success: true, duration_ms: 12.5, failure: null,
    events: undefined
  });
  assert.equal(entry.events.length, 3);
  assert.deepEqual(entry.events[1].response, { status: 200, reason: 'OK', headers: [], body: 'xxxx', body_truncated: true });
  assert.equal(entry.events[1].request.body, null);
  assert.equal(completed.response.body.length, 10, 'the events of the run are not changed');
});

test('a call that sent nothing has no history entry; a failed one has', () => {
  const invalid = [{ event: 'invalid', errors: [{ message: "missing required param 'id'" }] }];
  assert.equal(protocol.historyEntry({ file: 'a', endpoint: 'e', args: [], events: invalid, time: 1 }), undefined);

  const failed = [{ event: 'step_completed', success: false, failure: "Variable 'token' is not defined.", method: null, url: null, status: null, request: null, response: null }];
  const entry = protocol.historyEntry({ file: 'a', endpoint: 'e', args: [], events: failed, time: 1 });
  assert.equal(entry.success, false);
  assert.equal(entry.status, null);
  assert.equal(entry.environment, null);
  assert.equal(entry.failure, "Variable 'token' is not defined.");
});

test('the history keeps the newest entries first, up to its size', () => {
  assert.deepEqual(protocol.addToHistory([2, 1], 3, 2), [3, 2]);
  assert.deepEqual(protocol.addToHistory([], 1, 2), [1]);
});
