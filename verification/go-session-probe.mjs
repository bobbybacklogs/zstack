#!/usr/bin/env node
/**
 * Does `x-opencode-session` unblock the OpenCode Go lane?
 * Reads the key from ModelHitch's local .env (never printed).
 */
import { readFileSync } from 'node:fs';

const key = process.env.PROBE_OPENCODE_KEY;
if (!key) throw new Error('set PROBE_OPENCODE_KEY before running this probe');

const session = process.argv[2] || 'zstack-probe-session-0001';
const withSession = process.argv[3] !== 'nosession';
const model = process.argv[4] || 'deepseek-v4-pro';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
  'User-Agent': 'zstack/0.1.0'
};
if (withSession) headers['x-opencode-session'] = session;

const res = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
  })
});

console.log(`session=${withSession} model=${model} -> HTTP ${res.status}`);
const text = await res.text();
console.log(text.slice(0, 700));
