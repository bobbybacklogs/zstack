#!/usr/bin/env node
/**
 * Hunt for models that emit DSML tool-call markup in `content` instead of
 * populating `tool_calls`. Reports which model/lane combinations leak.
 *
 * Usage: node verification/dsml-hunt.mjs [model ...]
 */
const base = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';

const defaultModels = [
  'opencode-go/deepseek-v4-pro',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/deepseek-v4.1-flash',
  'opencode-go/glm-5.3',
  'opencode-go/kimi-k3',
  'opencode-go/qwen3.8-max',
  'opencode-go/minimax-m3',
  'opencode/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash'
];

const models = process.argv.slice(2).length ? process.argv.slice(2) : defaultModels;

const messages = [
  {
    role: 'system',
    content: 'You are a coding agent. Inspect the repository using the provided tools. Do not describe calls in prose.'
  },
  { role: 'user', content: 'List the files in the current directory and show the working directory. Then read package.json.' }
];

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

const DSML = /<[｜|]{0,2}DSML[｜|]{0,2}/;

for (const model of models) {
  let status = 'ERR';
  let note = '';
  let leaked = false;
  let toolCallCount = 0;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' })
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) {
      try {
        note = (JSON.parse(text).error?.message || text).slice(0, 110).replace(/\s+/g, ' ');
      } catch {
        note = text.slice(0, 110);
      }
    } else {
      const msg = JSON.parse(text).choices?.[0]?.message ?? {};
      toolCallCount = (msg.tool_calls || []).length;
      const content = String(msg.content ?? '');
      leaked = DSML.test(content);
      if (leaked) note = 'DSML IN CONTENT: ' + content.slice(0, 90).replace(/\s+/g, ' ');
      else if (toolCallCount === 0) note = 'no tool_calls; content: ' + content.slice(0, 60).replace(/\s+/g, ' ');
    }
  } catch (err) {
    note = err.message;
  }
  console.log(
    `${String(status).padEnd(4)} calls=${toolCallCount} dsml=${leaked ? 'YES' : 'no '} ${model}${note ? '  <- ' + note : ''}`
  );
}
