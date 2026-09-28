#!/usr/bin/env node
/** Bisect which request shape makes the OpenCode Go lane fail through the bridge. */
const base = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3941';
const model = 'opencode-go/deepseek-v4-flash';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command to run' } },
        required: ['command'],
        additionalProperties: false
      }
    }
  }
];

const variants = {
  'user-only, no tools': { messages: [{ role: 'user', content: 'say hi' }] },
  'user-only + max_tokens': { messages: [{ role: 'user', content: 'say hi' }], max_tokens: 8 },
  'system+user': {
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'list files' }
    ]
  },
  'user-only + tools': { messages: [{ role: 'user', content: 'list files' }], tools: TOOLS, tool_choice: 'auto' },
  'system+user + tools': {
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'list files' }
    ],
    tools: TOOLS,
    tool_choice: 'auto'
  },
  'tools only, no system': { messages: [{ role: 'user', content: 'list files' }], tools: TOOLS },
  'empty content user': { messages: [{ role: 'user', content: '' }] }
};

for (const [label, extra] of Object.entries(variants)) {
  let status = 'ERR';
  let note = '';
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...extra })
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) {
      try {
        note = (JSON.parse(text).error?.message || text).slice(0, 120).replace(/\s+/g, ' ');
      } catch {
        note = text.slice(0, 120);
      }
    }
  } catch (err) {
    note = err.message;
  }
  console.log(`${String(status).padEnd(4)} ${label}${note ? '  <- ' + note : ''}`);
}
