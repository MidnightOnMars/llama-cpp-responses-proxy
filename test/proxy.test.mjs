import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPatchState,
  patchEventData,
  patchRequestBody,
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

test('patchRequestBody strips reasoning items and normalizes assistant messages', () => {
  const body = {
    model: 'gpt-oss-120b',
    input: [
      { role: 'developer', content: 'You are opencode.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Create hello.py' }] },
      { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: '' },
      {
        role: 'assistant',
        id: 'msg1',
        content: [{ type: 'output_text', text: 'I will write the file.' }],
      },
      {
        type: 'function_call',
        id: 'fc1',
        call_id: 'fc1',
        name: 'glob',
        arguments: '{"pattern":"hello.py"}',
      },
      { type: 'function_call_output', call_id: 'fc1', output: 'No files found' },
    ],
  };

  const result = patchRequestBody(body, '/v1/responses');

  assert.notStrictEqual(result, body);
  assert.deepStrictEqual(result.input, [
    { role: 'developer', content: 'You are opencode.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Create hello.py' }] },
    {
      role: 'assistant',
      type: 'message',
      id: 'msg1',
      content: [{ type: 'output_text', text: 'I will write the file.' }],
    },
    {
      type: 'function_call',
      id: 'fc1',
      call_id: 'fc1',
      name: 'glob',
      arguments: '{"pattern":"hello.py"}',
    },
    { type: 'function_call_output', call_id: 'fc1', output: 'No files found' },
  ]);
});

test('patchRequestBody leaves non-responses requests unchanged', () => {
  const body = {
    model: 'gpt-oss-120b',
    input: [{ type: 'reasoning', id: 'rs1' }],
  };

  const result = patchRequestBody(body, '/v1/chat/completions');

  assert.strictEqual(result, body);
});

test('patchRequestBody leaves responses requests unchanged when no reasoning items exist', () => {
  const body = {
    model: 'gpt-oss-120b',
    input: [{ role: 'developer', content: 'You are opencode.' }],
  };

  const result = patchRequestBody(body, '/v1/responses');

  assert.strictEqual(result, body);
});

test('patchRequestBody converts assistant string content to output_text messages', () => {
  const body = {
    model: 'gpt-oss-120b',
    input: [
      { role: 'assistant', content: 'Done.', id: 'msg2' },
    ],
  };

  const result = patchRequestBody(body, '/v1/responses');

  assert.deepStrictEqual(result.input, [
    {
      role: 'assistant',
      type: 'message',
      id: 'msg2',
      content: [{ type: 'output_text', text: 'Done.' }],
    },
  ]);
});

test('patchEventData normalizes bare error objects', () => {
  const result = patchEventData({
    error: {
      code: 500,
      message: 'boom',
      type: 'server_error',
    },
  }, createPatchState('gpt-oss-120b'));

  assert.deepStrictEqual(result, {
    type: 'error',
    sequence_number: 0,
    error: {
      code: '500',
      message: 'boom',
      type: 'server_error',
    },
  });
});
