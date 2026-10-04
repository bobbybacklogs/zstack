/**
 * Probe: what ids does OpenAI's own Responses stream carry for a tool call?
 *
 * ModelHitch keys its `tool-call-start` on the function call's `call_id` and its
 * `tool-call-args-delta` on the event's `item_id`. Those two must be the same
 * string for a consumer to join them, and they are not — so arguments vanish and
 * every tool call arrives with `{}`. This asks OpenAI directly which id it puts
 * on each event, so the fix targets the adapter that is actually wrong rather
 * than the one that merely looks wrong.
 *
 * Usage: node verification/openai-responses-ids-probe.mjs
 * Reads the key from ~/.modelhitch/config.json (keys.openai) or OPENAI_API_KEY.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const path = join(homedir(), '.modelhitch', 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  return config.keys?.openai;
}

const key = openaiKey();
if (!key) {
  console.log('No OpenAI key available.');
  process.exit(1);
}

const res = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: process.argv[2] || 'gpt-5.6-luna',
    stream: true,
    input: 'Read the file package.json using the read tool.',
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
  }),
});

console.log(`POST https://api.openai.com/v1/responses  ->  HTTP ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 600));
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
        const ev = JSON.parse(payload);
        const item = ev.item ?? {};
        const bits = [
          ev.item_id !== undefined ? `event.item_id=${ev.item_id}` : null,
          item.id !== undefined ? `item.id=${item.id}` : null,
          item.call_id !== undefined ? `item.call_id=${item.call_id}` : null,
          ev.delta !== undefined ? `delta=${JSON.stringify(String(ev.delta).slice(0, 32))}` : null,
        ].filter(Boolean);
        console.log(`${ev.type}${bits.length ? `   ${bits.join('  ')}` : ''}`);
      }
    }
    idx = buffer.indexOf('\n');
  }
}
