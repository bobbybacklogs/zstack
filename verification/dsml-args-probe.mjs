#!/usr/bin/env node
/**
 * Check whether recovered DSML calls carry usable arguments when the request
 * declares tools (the real agent case) versus when it does not.
 *
 * Usage: node verification/dsml-args-probe.mjs [model]
 */
const base = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/deepseek-v4-flash';

const tools = [
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
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  }
];

const messages = [
  { role: 'system', content: 'You are a coding agent with access to a bash tool. Use it to inspect the repository.' },
  { role: 'user', content: 'List the files in the current directory using bash.' }
];

async function run(label, withTools) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...(withTools ? { tools, tool_choice: 'auto' } : {}) })
  });
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const calls = msg.tool_calls || [];
  const empty = calls.filter(c => !c.function?.arguments || c.function.arguments === '{}').length;
  console.log(
    `${label.padEnd(16)} status=${res.status} calls=${calls.length} emptyArgs=${empty} finish=${data.choices?.[0]?.finish_reason}`
  );
  for (const c of calls) console.log(`    ${c.function?.name}(${c.function?.arguments})`);
}

await run('WITH tools', true);
await run('WITHOUT tools', false);
