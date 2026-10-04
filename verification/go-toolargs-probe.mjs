/**
 * Probe: does the OpenCode Go lane deliver tool-call arguments through the
 * ModelHitch bridge?
 *
 * Symptom under test: every tool call in a Go-lane run reaches the harness with
 * `args: {}`, so the harness rejects it as `Error: Tool arg "path" must be a
 * string` (or `subagent needs both "agent" and "task"`) in 0-4ms. A missing
 * *argument* is the tell: the tool name survives the round trip and only the
 * arguments are lost, which points at the streaming accumulator rather than at
 * routing, auth, or the tool executor.
 *
 * This hits the bridge directly so the provider adapter, not the harness, is
 * what is being observed. It prints every tool-call-related SSE payload and the
 * ids the two kinds of event carry, because the accumulator joins a
 * `tool-call-args-delta` to its `tool-call-start` by id.
 *
 * Usage: node verification/go-toolargs-probe.mjs [model]
 */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';
const model = process.argv[2] || 'opencode-go/gpt-5.6-luna';

const body = {
  model,
  stream: true,
  messages: [
    { role: 'user', content: 'Read the file package.json, then answer DONE.' },
  ],
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

console.log(`POST ${baseUrl}/v1/chat/completions  model=${model}  ->  HTTP ${res.status}`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}

let sawArgs = false;
let sawToolCall = false;
let buffer = '';
const decoder = new TextDecoder();

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          console.log(`  [unparsed] ${payload.slice(0, 120)}`);
          idx = buffer.indexOf('\n');
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.tool_calls) {
          sawToolCall = true;
          for (const tc of delta.tool_calls) {
            const args = tc.function?.arguments;
            if (args) sawArgs = true;
            console.log(
              `  delta.tool_calls index=${tc.index} id=${JSON.stringify(tc.id)} ` +
                `name=${JSON.stringify(tc.function?.name)} args=${JSON.stringify(args)}`,
            );
          }
        }
        const reason = parsed.choices?.[0]?.finish_reason;
        if (reason) console.log(`  finish_reason=${reason}`);
      }
    }
    idx = buffer.indexOf('\n');
  }
}

console.log('');
console.log(`tool_call deltas seen: ${sawToolCall}`);
console.log(`argument deltas seen:  ${sawArgs}`);
console.log(
  sawToolCall && !sawArgs
    ? 'VERDICT: the provider streamed a tool call with no arguments at all.'
    : 'VERDICT: arguments were streamed; loss is downstream of the bridge.'
);
