#!/usr/bin/env node
/**
 * Regression probe for DSML leakage.
 *
 * The leak reproduces when a system prompt advertises a tool the request never
 * declares, which makes DeepSeek V4 emit its internal tool-call markup into the
 * text channel. This runs that shape repeatedly over both the streaming and
 * non-streaming paths and asserts no marker ever reaches the client.
 *
 * Usage: node verification/dsml-regression.mjs [model] [runs]
 */
const base = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/deepseek-v4-flash';
const runs = Number(process.argv[3] || 6);

const messages = [
  { role: 'system', content: 'You are a coding agent with access to a bash tool. Use it to inspect the repository.' },
  { role: 'user', content: 'List the files in the current directory using bash.' }
];

const DSML = /DSML/;

let leaks = 0;
let recovered = 0;
let plain = 0;

for (let i = 0; i < runs; i++) {
  // Non-streaming
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages })
    });
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const content = String(msg.content ?? '');
    const calls = (msg.tool_calls || []).length;
    if (DSML.test(content)) {
      leaks++;
      console.log(`run ${i} nonstream  LEAK  ${JSON.stringify(content.slice(0, 120))}`);
    } else if (calls > 0) {
      recovered++;
      console.log(`run ${i} nonstream  recovered calls=${calls} ${JSON.stringify(msg.tool_calls[0].function)}`);
    } else {
      plain++;
    }
  }

  // Streaming
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let calls = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta ?? {};
          if (typeof delta.content === 'string') content += delta.content;
          if (Array.isArray(delta.tool_calls)) calls += delta.tool_calls.length;
        } catch {
          /* keepalive */
        }
      }
    }
    if (DSML.test(content)) {
      leaks++;
      console.log(`run ${i} stream     LEAK  ${JSON.stringify(content.slice(0, 120))}`);
    } else if (calls > 0) {
      recovered++;
    } else {
      plain++;
    }
  }
}

console.log(`\nmodel=${model} runs=${runs} (x2 paths)`);
console.log(`DSML leaks reaching the client: ${leaks}`);
console.log(`DSML recovered into tool_calls: ${recovered}`);
console.log(`plain text responses:           ${plain}`);
process.exit(leaks > 0 ? 1 : 0);
