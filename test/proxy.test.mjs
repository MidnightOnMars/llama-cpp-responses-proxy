import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPatchState,
  patchEventData,
  patchSseBlock,
} from '../proxy.mjs';

test('patchEventData adds the fields needed for function call streaming', () => {
  const state = createPatchState('gpt-oss-120b');

  const created = patchEventData({
    type: 'response.created',
    response: {
      id: 'resp_1',
      status: 'in_progress',
    },
  }, state);

  assert.equal(created.response.model, 'gpt-oss-120b');
  assert.equal(typeof created.response.created_at, 'number');

  const added = patchEventData({
    type: 'response.output_item.added',
    item: {
      type: 'function_call',
      call_id: 'fc_call_1',
      name: 'get_weather',
      arguments: '',
      status: 'in_progress',
    },
  }, state);

  assert.equal(added.output_index, 0);
  assert.equal(added.item.id, 'fc_call_1');

  const delta = patchEventData({
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_call_1',
    delta: '{}',
  }, state);

  assert.equal(delta.output_index, 0);

  const done = patchEventData({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'fc_call_1',
      name: 'get_weather',
      arguments: '{}',
      status: 'completed',
    },
  }, state);

  assert.equal(done.output_index, 0);
  assert.equal(done.item.id, 'fc_call_1');

  const completed = patchEventData({
    type: 'response.completed',
    response: {
      output: [{
        type: 'function_call',
        call_id: 'fc_call_1',
        name: 'get_weather',
        arguments: '{}',
      }],
    },
  }, state);

  assert.deepEqual(completed.response.usage, {
    input_tokens: 0,
    output_tokens: 0,
  });
  assert.equal(completed.response.output[0].id, 'fc_call_1');
});

test('patchSseBlock preserves non-data lines and handles CRLF blocks', () => {
  const state = createPatchState('gpt-oss-120b');
  const block = [
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"fc_call_2","name":"get_weather","arguments":"","status":"in_progress"}}',
  ].join('\r\n');

  const patched = patchSseBlock(block, state);

  assert.match(patched, /^event: response\.output_item\.added/m);
  assert.match(patched, /"output_index":0/);
  assert.match(patched, /"id":"fc_call_2"/);
});

test('patchSseBlock passes through non-JSON data lines', () => {
  const state = createPatchState();
  assert.equal(patchSseBlock('data: [DONE]', state), 'data: [DONE]');
});
