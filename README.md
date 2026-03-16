# llama-cpp-responses-proxy

An SSE fix proxy for llama.cpp's `/v1/responses` streaming endpoint that adds fields required by the Vercel AI SDK, fixing silent tool call failures in OpenCode, Cursor, and other `@ai-sdk/openai`-based clients.

## The problem

llama.cpp's Responses API streaming implementation is missing three fields that `@ai-sdk/openai` validates with Zod schemas. When validation fails, the SDK silently drops `function_call` events and `finishReason` is always `"stop"` instead of `"tool-calls"`. Tools never execute. No error is shown.

### Missing fields

| Field | Events affected | Impact |
|---|---|---|
| `output_index` | `response.output_item.added`, `.done`, `response.function_call_arguments.delta` | Events fail Zod validation, SDK skips them entirely |
| `id` on `function_call` items | `response.output_item.added`, `.done` | SDK requires both `id` and `call_id`; llama.cpp only sends `call_id` |
| `created_at`, `model` on `response.created` | `response.created` | SDK expects `response.{id, created_at, model}`; llama.cpp only sends `response.{id, status}` |

The critical chain: `response.output_item.done` for function_call items fails validation → SDK never sets `hasFunctionCall = true` → `finishReason` is always `"stop"` → client never executes tool calls.

Upstream issue: [ggml-org/llama.cpp#20607](https://github.com/ggml-org/llama.cpp/issues/20607)

## Usage

```bash
# Default: proxy on :9998, llama.cpp on :8080
node proxy.mjs

# Custom ports
LLAMA_CPP_URL=http://192.168.1.100:8080 PROXY_PORT=9999 node proxy.mjs
```

| Variable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://127.0.0.1:8080` | llama.cpp server URL |
| `PROXY_PORT` | `9998` | Port the proxy listens on |

Then point your client at `http://127.0.0.1:9998` instead of the llama.cpp server directly.

### OpenCode config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai",
      "name": "Local LLM",
      "options": {
        "baseURL": "http://127.0.0.1:9998/v1",
        "apiKey": "not-needed"
      },
      "models": {
        "my-model": {
          "name": "My Local Model",
          "tool_call": true
        }
      }
    }
  },
  "model": "local/my-model"
}
```

If your model outputs reasoning tokens, add `"reasoning": true` and `"interleaved": { "field": "reasoning_content" }` to the model config.

### Cursor

Set the OpenAI API base URL to `http://127.0.0.1:9998/v1` in Cursor's model settings.

## When you don't need this

If you use `@ai-sdk/openai-compatible` instead of `@ai-sdk/openai`, your client routes through Chat Completions (`/v1/chat/completions`), not the Responses API. llama.cpp's Chat Completions streaming works correctly — no proxy needed.

```json
{
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "baseURL": "http://127.0.0.1:8080/v1",
    "apiKey": "not-needed"
  }
}
```

The proxy is only needed when your client forces the Responses API path (which `@ai-sdk/openai` does unconditionally via `createResponsesModel()`).

## How it works

The proxy sits between your client and llama.cpp. Non-SSE requests (health checks, non-streaming responses) pass through unchanged. For SSE streams, it parses each event, injects the missing fields, and forwards the patched event. ~120 lines of Node.js, zero dependencies.

## License

MIT
