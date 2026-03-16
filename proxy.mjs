// llama-cpp-responses-proxy
// Patches llama.cpp's /v1/responses streaming SSE to add fields required by
// the Vercel AI SDK (@ai-sdk/openai). Without these fields, tool calls silently
// fail — the SDK drops function_call events and finishReason is always "stop".
//
// Missing fields patched:
//   1. output_index on output_item.added/.done and function_call_arguments.delta
//   2. id on function_call items (SDK requires both id and call_id)
//   3. created_at and model on response.created
//
// See: https://github.com/ggml-org/llama.cpp/issues/20607

import http from 'node:http';

const TARGET = process.env.LLAMA_CPP_URL || 'http://127.0.0.1:8080';
const PORT = parseInt(process.env.PROXY_PORT || '9998', 10);

const server = http.createServer((clientReq, clientRes) => {
  const url = new URL(clientReq.url, TARGET);
  const bodyChunks = [];

  clientReq.on('data', (c) => bodyChunks.push(c));
  clientReq.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    let requestModel = 'unknown';
    try { requestModel = JSON.parse(body.toString()).model || requestModel; } catch {}

    const proxyReq = http.request(url, {
      method: clientReq.method,
      headers: { ...clientReq.headers, host: url.host, 'content-length': body.length },
      timeout: 180000,
    }, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';

      if (ct.includes('text/event-stream')) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        let outputIdx = 0;
        const itemIndexMap = new Map();
        let model = requestModel;
        let buf = '';

        proxyRes.setEncoding('utf-8');
        proxyRes.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);

            const lines = block.split('\n');
            const outLines = [];
            for (const line of lines) {
              let out = line;
              if (line.startsWith('data: ')) {
                try {
                  const d = JSON.parse(line.slice(6));
                  const t = d.type || '';

                  if (t === 'response.created') {
                    const r = d.response || {};
                    if (!r.created_at) r.created_at = Math.floor(Date.now() / 1000);
                    if (!r.model) r.model = model;
                    d.response = r;
                    model = r.model || model;
                  } else if (t === 'response.output_item.added') {
                    if (d.output_index === undefined) d.output_index = outputIdx;
                    const item = d.item || {};
                    const id = item.id || item.call_id || '';
                    itemIndexMap.set(id, outputIdx);
                    outputIdx++;
                    if (item.type === 'function_call' && !item.id) {
                      item.id = item.call_id || `fc_${outputIdx}`;
                    }
                  } else if (t === 'response.output_item.done') {
                    if (d.output_index === undefined) {
                      const item = d.item || {};
                      const id = item.id || item.call_id || '';
                      d.output_index = itemIndexMap.get(id) ?? 0;
                    }
                    const item = d.item || {};
                    if (item.type === 'function_call' && !item.id) {
                      item.id = item.call_id || `fc_done_${d.output_index}`;
                    }
                  } else if (t === 'response.function_call_arguments.delta') {
                    if (d.output_index === undefined) {
                      d.output_index = itemIndexMap.get(d.item_id) ?? 0;
                    }
                  } else if (t === 'response.completed' || t === 'response.incomplete') {
                    const r = d.response || {};
                    if (Array.isArray(r.output)) {
                      for (const item of r.output) {
                        if (item.type === 'function_call' && !item.id) {
                          item.id = item.call_id || 'fc_final';
                        }
                      }
                    }
                    if (!r.usage) {
                      r.usage = { input_tokens: 0, output_tokens: 0 };
                    }
                  } else if (t === 'error') {
                    if (d.sequence_number === undefined) d.sequence_number = 0;
                    const err = d.error || {};
                    if (typeof err.code === 'number') err.code = String(err.code);
                  }

                  out = 'data: ' + JSON.stringify(d);
                } catch {}
              }
              outLines.push(out);
            }
            clientRes.write(outLines.join('\n') + '\n\n');
          }
        });

        proxyRes.on('end', () => {
          if (buf.trim()) clientRes.write(buf);
          clientRes.end();
        });

        proxyRes.on('error', (e) => {
          console.error('Proxy response error:', e.message);
          clientRes.end();
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    });

    proxyReq.on('error', (e) => {
      console.error('Proxy request error:', e.message);
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: e.message }));
    });

    proxyReq.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`llama-cpp-responses-proxy listening on 127.0.0.1:${PORT}`);
  console.log(`Forwarding to ${TARGET}`);
});
