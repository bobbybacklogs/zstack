#!/usr/bin/env node
/** Capture the exact failure for an opencode-go model call so we can act on it. */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/deepseek-v4-flash';
const withTools = process.argv[3] !== 'notools';

const body = {
  model,
  messages: [{ role: 'user', content: 'say hi' }],
  ...(withTools
    ? {
        tools: [
          {
            type: 'function',
            function: {
              name: 'bash',
              description: 'run a shell command',
              parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
            }
          }
        ],
        tool_choice: 'auto'
      }
    : {})
};

const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
console.log(`model=${model} tools=${withTools} -> HTTP ${res.status}`);
console.log(await res.text());
