/**
 * Probe: trace the raw Responses-API event ids the bridge emits for a streamed
 * tool call.
 *
 * The harness client was observed receiving `tool-call-start` with one id and
 * every `tool-call-args-delta` with a different one, so the accumulator appends
 * to nothing and the model's arguments vanish — every tool call then reaches the
 * executor as `{}` and is rejected in ~1ms. This prints every SSE event that
 * carries an id so the divergence can be located precisely (upstream vs bridge).
 *
 * Usage: node verification/go-responses-ids-probe.mjs [model]
 */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/gpt-5.6-luna';

const body = {
  model,
  stream: true,
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Read the file package.json using the read tool.' }],
    },
  ],
  tools: [
    {
      type: 'function',
      name: 'read',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to read.' } },
        required: ['path'],
      },
    },
  ],
  tool_choice: 'auto',
};

const res = await fetch(`${baseUrl}/v1/responses`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log(`POST ${baseUrl}/v1/responses  model=${model}  ->  HTTP ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 500));
  process.exit(1);
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const ev = JSON.parse(payload);
          const item = ev.item ?? {};
          const ids = [
            ev.item_id !== undefined ? `event.item_id=${ev.item_id}` : null,
            item.id !== undefined ? `item.id=${item.id}` : null,
            item.call_id !== undefined ? `item.call_id=${item.call_id}` : null,
            ev.call_id !== undefined ? `event.call_id=${ev.call_id}` : null,
            ev.delta !== undefined ? `delta=${JSON.stringify(String(ev.delta).slice(0, 40))}` : null,
          ]
            .filter(Boolean)
            .join('  ');
          console.log(`${ev.type}${ids ? `   ${ids}` : ''}`);
        } catch {
          console.log(`[unparsed] ${payload.slice(0, 120)}`);
        }
      }
    }
    idx = buffer.indexOf('\n');
  }
}
