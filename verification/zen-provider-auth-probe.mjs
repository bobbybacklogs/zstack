/**
 * Probe: does the Anthropic Messages adapter (the Zen/Claude wire) send the
 * stored key, and when did it come back without one?
 *
 * A Claude run on the Zen lane failed before its first turn with "Missing API
 * key". The stored key is present and the Zen endpoint answers it (402,
 * insufficient funds), so the two do not add up. The harness makes its calls
 * through `ModelHitch` + a keystore, which is a different path from a raw fetch;
 * this reproduces that path and prints the request headers and the response so
 * the disagreement is resolved by observation rather than by guessing.
 *
 * The provider comes from the package entry point, so the probe measures the
 * artifact the harness actually loads rather than a chunk file picked by name.
 *
 * Usage: node verification/zen-provider-auth-probe.mjs [provider/model]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const modelhitchRoot = process.env.MODELHITCH_DIR
  || 'C:/Users/labs/OneDrive/Documents/GitHub/ModelHitch';

const { AnthropicProvider } = await import(`file:///${modelhitchRoot}/dist/index.js`);

const cfg = JSON.parse(readFileSync(join(homedir(), '.modelhitch', 'config.json'), 'utf8'));
const key = cfg.keys?.opencode ?? '';
console.log(`stored opencode key: length=${key.length} prefix=${key.slice(0, 6)}`);

const model = (process.argv[2] || 'opencode/claude-sonnet-4-6').replace(/^(?:opencode|opencode-go)\//, '');

// 1. What the adapter sends, with the key handed to it the way the harness does.
const seen = [];
const provider = new AnthropicProvider({
  id: 'opencode',
  name: 'OpenCode Zen',
  baseUrl: 'https://opencode.ai/zen/v1',
  messagesPath: '/messages',
  authScheme: 'bearer-and-x-api-key',
  apiKeyEnvVar: 'OPENCODE_API_KEY',
  headers: { 'User-Agent': 'ModelHitch-OpenCode/2.0' },
  fetchImpl: async (url, init) => {
    const headers = init?.headers ?? {};
    seen.push({
      url: String(url),
      auth: headers.Authorization ? `${String(headers.Authorization).slice(0, 14)}…` : '(none)',
      hasApiKeyHeader: Boolean(headers['x-api-key']),
    });
    return fetch(url, init);
  },
});

try {
  const result = await provider.chat(
    { model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 },
    { apiKey: key },
  );
  console.log('chat ok:', JSON.stringify(result.message).slice(0, 200));
} catch (err) {
  console.log('chat threw:', err?.constructor?.name, '-', err?.message);
}
console.log('requests the adapter made:');
for (const s of seen) console.log(' ', JSON.stringify(s));

// 2. The same request by hand, to confirm what this endpoint accepts.
const manual = await fetch('https://opencode.ai/zen/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'ModelHitch-OpenCode/2.0',
    Authorization: `Bearer ${key}`,
    'x-api-key': key,
  },
  body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
});
console.log(`manual fetch with both headers: HTTP ${manual.status} ${(await manual.text()).slice(0, 160)}`);
