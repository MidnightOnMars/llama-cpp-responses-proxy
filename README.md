# llama-cpp-responses-proxy

An SSE compatibility proxy for llama.cpp's `/v1/responses` streaming endpoint. It patches missing OpenAI Responses fields so strict clients such as `@ai-sdk/openai` stop dropping `function_call` chunks, and normalizes request bodies so multi-turn tool-calling conversations work.

This is a compatibility shim, not a new tool-calling strategy. The real fix belongs upstream in llama.cpp.

## Status

Verified on March 17, 2026:

- llama.cpp issue [#20607](https://github.com/ggml-org/llama.cpp/issues/20607) is still open
- current `@ai-sdk/openai` still reproduces the failure
- the proxy restores `finishReason: "tool-calls"` and surfaces tool-call chunks in an end-to-end repro
- multi-turn tool-calling conversations (continuation after tool results) work through the proxy

## The problem

llama.cpp's Responses API streaming implementation is missing three fields that `@ai-sdk/openai` currently expects in its streaming chunk schema:

| Field | Events affected | Impact |
|---|---|---|
| `output_index` | `response.output_item.added`, `.done`, `response.function_call_arguments.delta` | function-call chunks are treated as unknown and ignored |
| `id` on `function_call` items | `response.output_item.added`, `.done` | `function_call` items fail schema validation even when `call_id` is present |
| `created_at`, `model` on `response.created` | `response.created` | the created event does not match the expected Responses shape |

The critical chain is:

`response.output_item.done` for a function call is ignored -> `hasFunctionCall` never becomes true -> `finishReason` stays `"stop"` instead of `"tool-calls"` -> tool execution never starts.

Additionally, after a successful tool call, clients like OpenCode include prior `reasoning` items and malformed assistant messages in follow-up requests. llama.cpp rejects these with `400 item['content'] is not an array`.

Upstream issue: [ggml-org/llama.cpp#20607](https://github.com/ggml-org/llama.cpp/issues/20607)

## When you should use this

Use the proxy when your client insists on the OpenAI Responses API and expects OpenAI-style streaming chunks.

This is specifically useful for OpenCode configs that use:

```json
{
  "npm": "@ai-sdk/openai"
}
```

It may also help other strict Responses clients, but the repo is specifically vetted against `@ai-sdk/openai`.

## A note on Chat Completions

Some clients can target `/v1/chat/completions` via `@ai-sdk/openai-compatible` instead of the Responses API. llama.cpp's Chat Completions streaming already works for tool calling without a proxy.

However, **Chat Completions is not reliable for all clients.** In production testing with OpenCode and llama.cpp, the `@ai-sdk/openai-compatible` path produced zero `tool_use` events across 27 consecutive attempts. The Responses API path via this proxy is the only validated path for OpenCode with llama.cpp.

If you are using a different client that does not rely on the Vercel AI SDK's Responses integration, Chat Completions may work for you. Test your specific setup before assuming it does.

## Usage

```bash
# Default: proxy on 127.0.0.1:9998, llama.cpp on 127.0.0.1:8080
node proxy.mjs

# Custom target / bind host / port
LLAMA_CPP_URL=https://my-llama-host:8080 PROXY_HOST=0.0.0.0 PROXY_PORT=9999 node proxy.mjs
```

| Variable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://127.0.0.1:8080` | llama.cpp server URL |
| `PROXY_HOST` | `127.0.0.1` | Host the proxy listens on |
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

## How it works

The proxy sits between your client and llama.cpp, patching both requests and responses.

**Request patching:** For `/v1/responses` requests, the proxy normalizes the request body before forwarding it to llama.cpp. This strips `reasoning` items that llama.cpp doesn't understand and normalizes assistant messages (adding `type: "message"`, converting string content to `output_text` arrays, converting `input_text` parts to `output_text` parts). This is essential for multi-turn tool-calling conversations where the client includes prior conversation history.

**Response patching:** For SSE streams, the proxy parses each event block, injects the missing fields (`output_index`, `id`, `created_at`, `model`), and forwards the patched event. Non-SSE requests pass through unchanged.

The implementation also:

- supports both `http://` and `https://` upstream targets
- handles LF and CRLF SSE framing
- normalizes bare error objects from llama.cpp (adds missing `type: "error"`)
- includes a `node:test` suite for the patching logic

## Development

```bash
npm test
```

## License

MIT
