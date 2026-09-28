#!/usr/bin/env node
/**
 * Probe: do DeepSeek-family models emit DSML tool-call markup in `content`
 * instead of populating `tool_calls` when given a standard OpenAI tools array?
 *
 * Usage: node verification/dsml-probe.mjs [model ...]
 */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['opencode-go/deepseek-v4-flash', 'opencode/deepseek-v4-pro', 'deepseek-v4-flash'];

const body = {
  messages: [
    {
      role: 'system',
      content: 'You are a coding agent. Use the provided tools to inspect the repository. Call tools instead of describing them.'
    },
    { role: 'user', content: 'List the files in the current directory and show the working directory path.' }
  ],
  tools: [
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
  ],
  tool_choice: 'auto'
};

for (const model of models) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model })
    });
  } catch (err) {
    console.log(`\n=== ${model} ===\nTRANSPORT ERROR: ${err.message}`);
    continue;
  }
  const text = await res.text();
  console.log(`\n=== ${model} (HTTP ${res.status}, ${Date.now() - started}ms) ===`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(text.slice(0, 800));
    continue;
  }
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  console.log('finish_reason :', choice?.finish_reason);
  console.log('tool_calls    :', JSON.stringify(message.tool_calls ?? null));
  const content = message.content || '';
  const dsml = /DSML/.test(content);
  console.log('content has DSML:', dsml);
  console.log('content       :', content.slice(0, 600));
  if (message.reasoning_content) console.log('reasoning     :', String(message.reasoning_content).slice(0, 300));
}
