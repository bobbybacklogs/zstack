#!/usr/bin/env node
/**
 * Ask a live bridge N times for a response that should be tool-call shaped, and
 * report how many responses leaked tool-call markup into `content` instead of
 * populating `tool_calls`.
 *
 * This is the regression check for the bare `<tool_calls>` / `<invoke>` variant
 * that DeepSeek emits when its marker tokens do not survive decoding. Run it
 * against the bridge the CLI actually uses.
 *
 * `--zstack-prompt` reproduces the condition that produced the original leak: a
 * system prompt carrying a playbook whose steps imply tool use, with no `tools`
 * array declared. A plain user message does not reliably trigger it, so testing
 * only the simple case proves nothing.
 *
 * Usage: node verification/bridge-markup-probe.mjs [baseUrl] [runs] [model] [--zstack-prompt]
 */
const argv = process.argv.slice(2);
const useZstackPrompt = argv.includes('--zstack-prompt');
const positional = argv.filter((a) => !a.startsWith('--'));
const baseUrl = positional[0] || 'http://127.0.0.1:3939';
const runs = Number(positional[1] || 6);
const model = positional[2] || 'opencode-go/deepseek-v4-pro';

const prompt =
  'Inspect the current working directory. Use a shell command to list the top-level files, then report what you found.';

/** zstack's real system prompt for a feature task, with no tools declared. */
async function buildZstackSystemPrompt() {
  const { ZStack, ZSTACK_SYSTEM_PROMPT } = await import('../src/index.mjs');
  const z = new ZStack({ baseUrl });
  const playbook = z.getPlaybook('feature');
  const principleNames = z.classifyPrompt(prompt).principles;
  const principles = principleNames
    .map((name) => {
      try {
        return `### Principle: ${name}\n${z.getPrinciple(name)}`;
      } catch {
        return `### Principle: ${name}`;
      }
    })
    .join('\n\n');
  return [ZSTACK_SYSTEM_PROMPT, '', `\n## Applicable Task Playbook:\n${playbook}`, `\n## Applicable Principles:\n${principles}`].join('\n\n');
}

const systemPrompt = useZstackPrompt ? await buildZstackSystemPrompt() : null;
console.log(`endpoint: ${baseUrl}`);
console.log(`model   : ${model}`);
console.log(`prompt  : ${useZstackPrompt ? `zstack playbook system prompt (${systemPrompt.length} chars), no tools declared` : 'plain user message'}\n`);

const tally = { realToolCalls: 0, dsmlInContent: 0, bareInContent: 0, plainText: 0 };
const samples = [];

for (let i = 0; i < runs; i++) {
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false })
    });
  } catch (err) {
    console.error(`run ${i}: request failed: ${err.message}`);
    continue;
  }

  if (!response.ok) {
    console.error(`run ${i}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    continue;
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const hasDsml = /DSML/.test(content);
  const hasBare = /<\s*(?:tool_calls|function_calls|invoke|parameter)\b/i.test(content);

  let kind;
  if (calls.length > 0) kind = 'real tool_calls';
  else if (hasDsml) kind = 'DSML markup in content';
  else if (hasBare) kind = 'bare markup in content';
  else kind = 'plain text';

  if (calls.length > 0) tally.realToolCalls++;
  else if (hasDsml) tally.dsmlInContent++;
  else if (hasBare) tally.bareInContent++;
  else tally.plainText++;

  console.log(`run ${String(i).padStart(2)}  finish=${String(choice?.finish_reason).padEnd(11)} calls=${calls.length}  ${kind}`);
  if (calls.length === 0 && (hasDsml || hasBare)) {
    samples.push(content.slice(0, 180).replace(/\n/g, '\\n'));
  }
}

console.log(`\n--- ${baseUrl} (${model}) over ${runs} runs ---`);
for (const [key, value] of Object.entries(tally)) console.log(`${key.padEnd(18)} ${value}`);

const leaks = tally.dsmlInContent + tally.bareInContent;
if (leaks > 0) {
  console.log(`\nFAIL: ${leaks} response(s) leaked tool-call markup into content:`);
  for (const sample of samples) console.log(`  ${sample}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: no tool-call markup reached content.');
}
