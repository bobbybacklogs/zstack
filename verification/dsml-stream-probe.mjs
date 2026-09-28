#!/usr/bin/env node
/**
 * Probe DSML leakage on the streaming path and with parallel/multi-invoke tool
 * blocks, which the reported failure showed (`<|DSML|calls>` with 2 invokes).
 *
 * Usage: node verification/dsml-stream-probe.mjs [model ...]
 */
const base = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'];

const DSML = /DSML/;

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false
      }
    }
  }
];

const parallelPrompt = [
  {
    role: 'system',
    content: 'You are a coding agent. Call tools. Do not describe calls in prose.'
  },
  {
    role: 'user',
    content:
      'Do these as separate tool calls in one turn: 1) find . -maxdepth 2 excluding node_modules and .git | head -100, 2) pwd && ls -la. Emit both calls now.'
  }
];

const noToolsPrompt = [
  { role: 'system', content: 'You are a coding agent with access to a bash tool.' },
  { role: 'user', content: 'List the files in the current directory using bash.' }
];

async function run(label, model, body, stream) {
  let status = 'ERR';
  let note = '';
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body, ...(stream ? { stream: true } : {}) })
    });
    status = res.status;
    if (!res.ok) {
      const t = await res.text();
      note = t.slice(0, 120).replace(/\s+/g, ' ');
      console.log(`${String(status).padEnd(4)} ${label} ${model}  <- ${note}`);
      return;
    }
    if (!stream) {
      const data = JSON.parse(await res.text());
      const msg = data.choices?.[0]?.message ?? {};
      const content = String(msg.content ?? '');
      console.log(
        `${String(status).padEnd(4)} ${label} ${model} calls=${(msg.tool_calls || []).length} dsml=${DSML.test(content) ? 'YES' : 'no'}`
      );
      if (DSML.test(content)) console.log('      content:', JSON.stringify(content.slice(0, 300)));
      return;
    }

    // Streaming: collect every delta so partial DSML cannot hide in a chunk.
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
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (typeof delta.content === 'string') content += delta.content;
          if (Array.isArray(delta.tool_calls)) calls += delta.tool_calls.length;
        } catch {
          // ignore keepalives
        }
      }
    }
    console.log(
      `${String(status).padEnd(4)} ${label} ${model} stream-calls=${calls} dsml=${DSML.test(content) ? 'YES' : 'no'} contentLen=${content.length}`
    );
    if (DSML.test(content)) console.log('      content:', JSON.stringify(content.slice(0, 400)));
    else if (content.length > 0) console.log('      content:', JSON.stringify(content.slice(0, 200)));
  } catch (err) {
    console.log(`${String(status).padEnd(4)} ${label} ${model}  <- ${err.message}`);
  }
}

for (const model of models) {
  await run('nonstream-parallel', model, { messages: parallelPrompt, tools, tool_choice: 'auto' }, false);
  await run('stream-parallel   ', model, { messages: parallelPrompt, tools, tool_choice: 'auto' }, true);
  await run('stream-notools    ', model, { messages: noToolsPrompt }, true);
}
