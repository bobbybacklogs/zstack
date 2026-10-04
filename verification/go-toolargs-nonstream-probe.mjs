/**
 * Probe: does the OpenCode Go lane deliver tool-call arguments on the
 * NON-streaming path?
 *
 * Companion to `go-toolargs-probe.mjs`. The streaming path was verified to
 * carry arguments, so if the non-streaming path drops them the loss is in the
 * bridge's `chat` handling rather than in the harness or the executor.
 *
 * Usage: node verification/go-toolargs-nonstream-probe.mjs [model]
 */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/gpt-5.6-luna';

const body = {
  model,
  stream: false,
  messages: [{ role: 'user', content: 'Read the file package.json, then answer DONE.' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file from the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File to read.' } },
          required: ['path'],
        },
      },
    },
  ],
  tool_choice: 'auto',
};

const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log(`POST ${baseUrl}/v1/chat/completions (stream:false)  model=${model}  ->  HTTP ${res.status}`);
const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.log(text.slice(0, 800));
  process.exit(1);
}

const message = parsed.choices?.[0]?.message;
console.log('finish_reason:', parsed.choices?.[0]?.finish_reason);
console.log('tool_calls:');
for (const [i, tc] of (message?.tool_calls ?? []).entries()) {
  console.log(`  [${i}] id=${JSON.stringify(tc.id)} name=${JSON.stringify(tc.function?.name)}`);
  console.log(`      arguments=${JSON.stringify(tc.function?.arguments)}`);
}
if (!message?.tool_calls?.length) {
  console.log('  (none)');
  console.log('content:', JSON.stringify(message?.content ?? '').slice(0, 200));
}
