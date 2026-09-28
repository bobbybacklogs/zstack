#!/usr/bin/env node
/**
 * Check which candidate model IDs the gateway actually serves. A 200 proves the
 * ID resolves end to end; 400/404 means the ID is stale and must not be picked.
 *
 * Usage: node verification/model-id-probe.mjs [id ...]
 */
const baseUrl = process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'deepseek/deepseek-v4-flash',
      'deepseek-v4-flash',
      'gemini/models/gemini-3.6-flash',
      'gemini/models/gemini-3.7-flash',
      'gemini/gemini-3.7-flash',
      'openai/gpt-5.6-luna',
      'opencode/deepseek-v4-pro',
      'opencode-go/deepseek-v4-pro'
    ];

for (const model of ids) {
  let status = 'ERR';
  let note = '';
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 })
    });
    status = res.status;
    const text = await res.text();
    if (!res.ok) {
      try {
        note = JSON.parse(text).error?.message?.slice(0, 150) ?? text.slice(0, 150);
      } catch {
        note = text.slice(0, 150);
      }
    }
  } catch (err) {
    note = err.message;
  }
  console.log(`${String(status).padEnd(5)} ${model}${note ? '  <- ' + note : ''}`);
}
