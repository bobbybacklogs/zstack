#!/usr/bin/env node
/**
 * Probe tool-call fidelity per OpenCode lane (zen vs go) directly against the
 * upstream endpoint, bypassing ModelHitch, so we can tell whether DSML leakage
 * is an upstream model behaviour or a ModelHitch normalization gap.
 *
 * Usage: PROBE_OPENCODE_KEY=<key> node verification/toolcall-probe.mjs <lane:model> [...]
 *   e.g. PROBE_OPENCODE_KEY=... node verification/toolcall-probe.mjs \
 *          go:deepseek-v4-pro go:deepseek-v4-flash go:glm-5.3 zen:deepseek-v4-pro
 */
const key = process.env.PROBE_OPENCODE_KEY;
if (!key) throw new Error('set PROBE_OPENCODE_KEY before running this probe');

const LANES = {
  zen: 'https://opencode.ai/zen/v1',
  go: 'https://opencode.ai/zen/go/v1'
};

const wires = {
  'chat/completions': (model) => ({
    path: '/chat/completions',
    body: {
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a coding agent. Call the provided tools. Do not describe the calls in prose.'
        },
        { role: 'user', content: 'List the files in the current directory, then print the working directory.' }
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
    }
  })
};

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['go:deepseek-v4-pro', 'go:deepseek-v4-flash', 'zen:deepseek-v4-pro'];

for (const target of targets) {
  const [lane, model] = target.split(':');
  const base = LANES[lane];
  if (!base || !model) {
    console.log(`skip malformed target ${target}`);
    continue;
  }
  const spec = wires['chat/completions'](model);
  const started = Date.now();
  const res = await fetch(`${base}${spec.path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': 'zstack-toolcall-probe/0.1.0',
      'x-opencode-session': `probe-${lane}-${model}`
    },
    body: JSON.stringify(spec.body)
  });
  const text = await res.text();
  console.log(`\n=== ${target} (HTTP ${res.status}, ${Date.now() - started}ms) ===`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(text.slice(0, 500));
    continue;
  }
  if (data.error) {
    console.log('ERROR:', JSON.stringify(data.error).slice(0, 400));
    continue;
  }
  const choice = data.choices?.[0] ?? {};
  const message = choice.message ?? {};
  console.log('finish_reason   :', choice.finish_reason);
  console.log('tool_calls      :', JSON.stringify(message.tool_calls ?? null).slice(0, 400));
  const content = String(message.content ?? '');
  console.log('content has DSML:', /DSML/.test(content));
  console.log('content         :', JSON.stringify(content.slice(0, 400)));
  if (message.reasoning_content) console.log('reasoning       :', JSON.stringify(String(message.reasoning_content).slice(0, 200)));
}
