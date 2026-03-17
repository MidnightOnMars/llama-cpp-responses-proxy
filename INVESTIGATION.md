# Responses API SSE Compatibility Investigation

Detailed findings from investigating why tool calls fail when using llama.cpp's `/v1/responses` streaming endpoint with strict OpenAI Responses clients such as `@ai-sdk/openai`.

## 1. Current status

As of March 16, 2026:

- llama.cpp issue [#20607](https://github.com/ggml-org/llama.cpp/issues/20607) is still open
- llama.cpp still omits `output_index` on streamed function-call events and omits `id` on streamed `function_call` items
- `@ai-sdk/openai` still routes generic OpenAI models through the Responses API
- the mismatch is still reproducible with current packages

Validated against:

- `@ai-sdk/openai` `3.0.41`
- `ai` `6.0.116`

## 2. What works and what does not

At the llama.cpp API level, tool calling itself works:

| Endpoint | Streaming | Tools | Result |
|---|---|---|---|
| `/v1/chat/completions` | No | Yes | works |
| `/v1/chat/completions` | Yes | Yes | works |
| `/v1/responses` | No | Yes | works |
| `/v1/responses` | Yes | Yes | model emits tool-call SSE correctly enough for humans and simple clients |

The break happens in strict Responses clients that validate stream chunks against OpenAI-style schemas.

| Client path | Result |
|---|---|
| `@ai-sdk/openai-compatible` -> Chat Completions | tool calls work |
| `@ai-sdk/openai` -> Responses API | tool calls are ignored unless the missing fields are patched |

## 3. Root cause

The current `@ai-sdk/openai` Responses stream parser still expects:

### Missing `output_index`

Required on:

- `response.output_item.added`
- `response.output_item.done`
- `response.function_call_arguments.delta`

llama.cpp does not emit it on those events today.

### Missing `id` on `function_call` items

For streamed `function_call` items, the SDK expects both:

- `id`
- `call_id`

llama.cpp emits only `call_id`.

### Missing `created_at` and `model` on `response.created`

The SDK expects `response.{id, created_at, model}` on the created event.
llama.cpp currently emits only `response.{id, status}` there.

## 4. Why tool execution never starts

The important failure is on streamed function-call items:

1. `response.output_item.added` and `response.output_item.done` for `function_call` do not match the expected schema
2. the parser treats them as unknown chunks
3. `hasFunctionCall` is never set
4. `finishReason` resolves to `"stop"` instead of `"tool-calls"`
5. downstream tool execution never starts

In an end-to-end repro with current `@ai-sdk/openai`, the unpatched stream finishes with:

- no tool-call parts
- empty step content
- `finishReason: "stop"`

The same stream through this proxy produces:

- `tool-input-start`
- `tool-input-delta`
- `tool-call`
- `finishReason: "tool-calls"`

## 5. Important nuance about other chunk types

Not every llama.cpp/OpenAI mismatch matters.

As of the current AI SDK:

- `response.content_part.added`
- `response.content_part.done`
- `response.output_text.done`
- `response.reasoning_text.delta`
- `response.in_progress`

are tolerated as unknown chunks or otherwise non-critical for this specific failure.

That is why the proxy only patches the function-call-critical fields plus `response.created`.

## 6. Why `@ai-sdk/openai` still hits this path

The current OpenAI provider still routes its generic language-model constructor through Responses:

```ts
const createLanguageModel = (modelId) => {
  return createResponsesModel(modelId);
};
```

So if a client uses `@ai-sdk/openai` for a custom/local provider, it still ends up on `/v1/responses`.

## 7. Best workaround vs best long-term fix

### Best workaround when you control the client

Prefer Chat Completions:

- use `@ai-sdk/openai-compatible`
- point it at `/v1/chat/completions`

That is simpler and lower-maintenance than a proxy.

### Best workaround when the client forces Responses

Use this proxy.

It is not a hack in the sense of changing the model output or inventing a new protocol. It is a narrow compatibility shim that fills fields the client already expects from an OpenAI-style Responses stream.

### Best long-term fix

Fix llama.cpp upstream so the Responses SSE emitter includes:

1. `output_index` on streamed output-item and function-call-argument events
2. `id` on streamed `function_call` items
3. `created_at` and `model` on `response.created`

## 8. Recommended upstream change set

Minimal upstream fix:

1. add `output_index` to `response.output_item.added`
2. add `output_index` to `response.output_item.done`
3. add `output_index` to `response.function_call_arguments.delta`
4. include `id` on streamed `function_call` items
5. include `created_at` and `model` on `response.created`

Nothing more is required to resolve the tool-calling failure reproduced here.
