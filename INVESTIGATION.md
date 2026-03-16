# Responses API SSE Compatibility Investigation

Detailed findings from investigating why tool calls silently fail when using `@ai-sdk/openai` with llama.cpp's `/v1/responses` streaming endpoint.

## 1. What works and what doesn't

### Direct API (curl) — everything works

| Endpoint | Streaming | Tools | Result |
|---|---|---|---|
| `/v1/chat/completions` | No | Yes | `finish_reason: "tool_calls"`, correct function call |
| `/v1/chat/completions` | Yes | Yes | Works (standard SSE delta format) |
| `/v1/responses` | No | Yes | `type: "function_call"` in output array, correct args |
| `/v1/responses` | Yes | Yes | Proper SSE: `response.function_call_arguments.delta` events |

llama.cpp handles both APIs correctly at the protocol level. The model produces structured tool calls reliably across both endpoints.

### Through @ai-sdk/openai — tool calls silently fail

| Adapter | API path | Result |
|---|---|---|
| `@ai-sdk/openai-compatible` | Chat Completions | Tool calls work |
| `@ai-sdk/openai` | Responses API | `finishReason: "stop"`, no tool execution |

`@ai-sdk/openai` always routes to the Responses API (via `createResponsesModel()`). There is no config option to change this. The SDK's Zod schema validation rejects llama.cpp's streaming events due to missing required fields.

## 2. Root cause

The AI SDK validates every streaming SSE event against a Zod discriminated union schema. Three categories of missing fields cause validation failures:

### Missing `output_index`

`response.output_item.added`, `response.output_item.done`, and `response.function_call_arguments.delta` all require an `output_index` field (number). llama.cpp omits it. Without it, events fail validation and `chunk.success` is false — the handler skips them with `return`.

### Missing `id` on function_call items

The SDK schema requires both `id` (string) and `call_id` (string) on function_call items inside `response.output_item.added` and `response.output_item.done`. llama.cpp only sends `call_id`. This causes the inner discriminated union to fail even when `output_index` is present.

### Missing `created_at` and `model` on response.created

The schema requires `response.{id, created_at, model}` but llama.cpp only sends `response.{id, status}`.

### The critical consequence

When `response.output_item.done` for a `function_call` item fails validation, the handler never sets `hasFunctionCall = true`. So `finishReason` is always `"stop"` instead of `"tool-calls"`. The client never executes tool calls. No error is surfaced.

## 3. SSE field comparison: AI SDK expected vs llama.cpp actual

### response.created

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `response.id` | Required (string) | Present |
| `response.created_at` | **Required** (number) | **Missing** |
| `response.model` | **Required** (string) | **Missing** |

### response.output_item.added / .done

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `type` | Required (string) | Present |
| `output_index` | **Required** (number) | **Missing** |
| `item` | Required (object) | Present |
| `item.id` (for function_call) | **Required** (string) | **Missing** (only `call_id` sent) |
| `item.call_id` (for function_call) | Required (string) | Present |

### response.function_call_arguments.delta

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `item_id` | Required (string) | Present |
| `output_index` | **Required** (number) | **Missing** |
| `delta` | Required (string) | Present |

### response.output_text.delta

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `item_id` | Required (string) | Present |
| `output_index` | **Required** (number) | **Missing** |
| `content_index` | **Required** (number) | **Missing** |
| `delta` | Required (string) | Present |

### response.content_part.added

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `item_id` | Required (string) | Present |
| `output_index` | **Required** (number) | **Missing** |
| `content_index` | **Required** (number) | **Missing** |
| `part` | **Required** (object) | **Missing** |

### Error events

| Field | AI SDK expects | llama.cpp sends |
|---|---|---|
| `sequence_number` | **Required** (number) | **Missing** |
| `error.code` | **Required** (string) | Number (e.g., `500`) |

## 4. Catch-all behavior

The SDK schema has a catch-all at the end:

```js
object({ type: string }).transform(v => ({ type: "unknown_chunk", message: v.type }))
```

Unknown event types like `response.reasoning_text.delta`, `response.in_progress`, `response.content_part.added/done`, and `response.output_text.done` are silently transformed to `unknown_chunk` and ignored. They do **not** crash the parser.

The actual `AI_TypeValidationError` only occurs when an event completely fails to match **any** variant including the catch-all — for example, error objects that lack a `type` field entirely.

## 5. Why @ai-sdk/openai always uses the Responses API

The `@ai-sdk/openai` provider's `createLanguageModel()` unconditionally calls `createResponsesModel()`:

```js
const createLanguageModel = (modelId) => {
    return createResponsesModel(modelId);
};
```

Clients that use custom providers (not built-in ones like "openai" or "azure") always fall through to `sdk.languageModel()` → Responses API. There is no config option to change this routing.

The `"compatibility": "compatible"` constructor option does **not** affect Responses API streaming event validation — it only affects Chat Completions response parsing.

## 6. Common configuration mistakes

### `"tools": true` (wrong field)

Not a valid model config field. The correct field is `"tool_call": true`. The `tools` field happened to work with `@ai-sdk/openai-compatible` because that adapter uses Chat Completions, where tool support is wired differently.

### `"api": "chat"` (not a mode selector)

The `api` field at the provider level is a URL string (equivalent to `baseURL`), not a mode switch. Setting it to `"chat"` causes the client to use `"chat"` as a URL.

### Missing reasoning config

Models that output reasoning tokens need:

```json
{
  "reasoning": true,
  "interleaved": {
    "field": "reasoning_content"
  }
}
```

Without this, the client doesn't know how to parse reasoning output items.

## 7. What the proxy fixes

The proxy (`proxy.mjs`) patches only the fields that matter:

1. **Adds `output_index`** — sequential counter to `response.output_item.added`, `.done`, and `response.function_call_arguments.delta`
2. **Adds `id` to function_call items** — copies `call_id` to `id` when missing
3. **Adds `created_at` and `model` to `response.created`** — extracts model from request body
4. **Patches `response.completed` output array** — adds `id` to function_call items
5. **Fixes error events** — converts `error.code` from number to string, adds `sequence_number`

All other events pass through unchanged and hit the SDK's catch-all → `unknown_chunk` → silently ignored.

## 8. Recommended upstream fix

The fix in llama.cpp's Responses API streaming implementation is minimal — three changes to the event emitter:

1. Add `output_index` (sequential counter starting at 0) to `response.output_item.added`, `response.output_item.done`, and `response.function_call_arguments.delta` events
2. Add `id` field to function_call items in output (can be same value as `call_id`)
3. Add `created_at` (unix timestamp) and `model` fields to the `response.created` event's response object

No changes needed for reasoning events, content_part events, or other event types — the AI SDK's catch-all handles them gracefully.
