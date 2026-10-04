/**
 * Probe: what does the harness's own ModelHitch client emit for a tool call on
 * the OpenCode Go lane?
 *
 * The bridge was already proven to stream arguments correctly (see
 * `go-toolargs-probe.mjs`), yet the harness ends up with `arguments: {}` and the
 * executor rejects the call in ~1ms. This reproduces the harness's own client
 * path — same config, same policy, same failover — and prints every StreamChunk
 * so the point where arguments disappear is visible instead of inferred.
 *
 * Usage: node verification/go-harness-chunks-probe.mjs [provider/model]
 */
const modelOverride = process.argv[2] || 'opencode-go/gpt-5.6-luna';
const modelhitchRoot = process.env.MODELHITCH_DIR
  || 'C:/Users/labs/OneDrive/Documents/GitHub/ModelHitch';

// The runtime chunk is content-hashed and its name changes on every rebuild, so
// it is discovered rather than hard-coded.
const { readdirSync } = await import('node:fs');
const distDir = `${modelhitchRoot}/dist`;
const runtimeChunk = readdirSync(distDir).find((f) => /^runtime-.*\.js$/.test(f));
if (!runtimeChunk) {
  console.log(`No runtime chunk found in ${distDir}`);
  process.exit(1);
}
const { loadHarnessRuntime } = await import(`file:///${distDir}/${runtimeChunk}`);

const runtime = await loadHarnessRuntime({ modelOverride, hintOnMissing: false });
console.log(`provider=${runtime.provider} model=${runtime.model}`);

const tools = [
  {
    name: 'read',
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File to read.' } },
      required: ['path'],
    },
  },
];

const messages = [
  { role: 'user', content: 'Read the file package.json using the read tool.' },
];

const stream = await runtime.client.stream({
  messages,
  tools,
  toolChoice: 'auto',
});

const calls = new Map();
let sawArgsDelta = false;
for await (const chunk of stream) {
  if (chunk.type === 'tool-call-start') {
    console.log(`  chunk tool-call-start id=${JSON.stringify(chunk.id)} name=${JSON.stringify(chunk.name)}`);
  } else if (chunk.type === 'tool-call-args-delta') {
    sawArgsDelta = true;
    console.log(`  chunk tool-call-args-delta id=${JSON.stringify(chunk.id)} argsDelta=${JSON.stringify(chunk.argsDelta)}`);
  } else if (chunk.type === 'tool-call-end') {
    console.log(`  chunk tool-call-end id=${JSON.stringify(chunk.id)}`);
  } else if (chunk.type === 'finish') {
    console.log(`  chunk finish reason=${chunk.finishReason}`);
  } else if (chunk.type === 'text-delta') {
    const text = String(chunk.text ?? '');
    if (text.trim() !== '') console.log(`  chunk text-delta ${JSON.stringify(text.slice(0, 200))}`);
  } else {
    console.log(`  chunk ${chunk.type}`);
  }
  if (chunk.type === 'tool-call-start') calls.set(chunk.id, { name: chunk.name, args: '' });
  if (chunk.type === 'tool-call-args-delta' && calls.has(chunk.id)) {
    calls.get(chunk.id).args += chunk.argsDelta;
  }
}

console.log('');
console.log(`argument deltas seen: ${sawArgsDelta}`);
for (const [id, call] of calls) {
  console.log(`accumulated ${call.name} (${id}) -> ${call.args === '' ? '<EMPTY>' : call.args}`);
}
