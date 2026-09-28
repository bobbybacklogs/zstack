#!/usr/bin/env node
/**
 * Acceptance check for the three reported defects.
 *
 *   1. `--about` (and every other command) must not print raw sync messages such
 *      as "[manifest] playbooks/authoring-a-skill.md: no frontmatter, using
 *      legacy extraction".
 *   2. OpenCode Go must be selectable as a lane (`--go`, `--lane go`) and must
 *      return 200 through the gateway rather than MissingSessionID.
 *   3. DeepSeek DSML tool-call markup must never reach the client; it is
 *      recovered into real tool_calls.
 *
 * Usage: node verification/acceptance.mjs [gatewayUrl]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = new URL('../bin/zstack.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const gateway = process.argv[2] || process.env.MODELHITCH_BASE_URL || 'http://127.0.0.1:3939';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, MODELHITCH_BASE_URL: gateway, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

// ---------------------------------------------------------------- 1. no raw sync output
{
  const { stdout, stderr, code } = await runCli(['--about']);
  const combined = `${stdout}\n${stderr}`;
  const rawManifest = /\[manifest\]|no frontmatter|legacy extraction/i.test(combined);
  record('--about prints no raw sync/manifest noise', code === 0 && !rawManifest,
    rawManifest ? `found: ${combined.match(/.*\[manifest\].*/i)?.[0]}` : 'clean');
  record('--about reports playbook and principle counts', /15 SOPs/.test(combined) && /20 Rules/.test(combined));
}

for (const args of [['status'], ['playbooks'], ['principles'], ['budget', 'med-high', '--source', 'catalog', '--lane', 'go']]) {
  const { stdout, stderr } = await runCli(args);
  const noisy = /\[manifest\]|no frontmatter|legacy extraction/i.test(`${stdout}\n${stderr}`);
  record(`zstack ${args.join(' ')} prints no raw sync noise`, !noisy);
}

// ---------------------------------------------------------------- 2. lanes
for (const [flag, lane, prefix] of [
  ['--zen', 'zen', 'opencode/'],
  ['--go', 'go', 'opencode-go/'],
  ['--hitch', 'hitch', null],
]) {
  const { stdout, code } = await runCli(['budget', 'med-high', '--source', 'catalog', flag]);
  const laneLine = stdout.split('\n').find((l) => l.trim().startsWith('> ' + lane)) ?? '';
  const models = [...stdout.matchAll(/-> (\S+)/g)].map((m) => m[1]);
  const inFamily = prefix
    ? models.length > 0 && models.every((m) => m.startsWith(prefix))
    : models.length > 0 && models.every((m) => !m.includes('opencode'));
  record(`${flag} selects the ${lane} lane and stays in family`, code === 0 && laneLine.trim().startsWith('> ') && inFamily,
    `${models.length} role models, e.g. ${models.slice(0, 3).join(', ')}`);
}

// Real dispatch on the Go lane.
{
  const { stdout, code } = await runCli(['--go', '--role', 'fast', 'Reply with exactly: acceptance-ok']);
  record('--go dispatches a real task', code === 0 && /acceptance-ok/i.test(stdout),
    stdout.split('\n').filter((l) => /Model:|acceptance-ok/.test(l)).join(' | ').slice(0, 200));
}

// Go lane over the gateway, with tools declared (previously HTTP 400).
{
  const res = await fetch(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'opencode-go/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'List files.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      }],
      tool_choice: 'auto',
    }),
  });
  const text = await res.text();
  const missing = /MissingSessionID/.test(text);
  record('opencode-go succeeds through the gateway', res.status === 200 && !missing,
    `HTTP ${res.status}${missing ? ' (MissingSessionID)' : ''}`);
}

// ---------------------------------------------------------------- 3. DSML recovery
{
  const messages = [
    { role: 'system', content: 'You are a coding agent with access to a bash tool. Use it to inspect the repository.' },
    { role: 'user', content: 'List the files in the current directory using bash.' },
  ];
  const tools = [{
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  }];

  let leaks = 0;
  let recovered = 0;
  const runs = 6;

  for (let i = 0; i < runs; i++) {
    for (const stream of [false, true]) {
      const res = await fetch(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'opencode-go/deepseek-v4-flash', messages, tools, tool_choice: 'auto', ...(stream ? { stream: true } : {}) }),
      });
      if (!stream) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message ?? {};
        if (/DSML/.test(String(msg.content ?? ''))) leaks++;
        else if ((msg.tool_calls || []).length > 0) recovered++;
      } else {
        const raw = await res.text();
        // Any DSML token in a streamed content delta would surface in the raw SSE.
        const contentDeltas = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
        if (/DSML/.test(contentDeltas)) leaks++;
        else if (/"tool_calls"/.test(raw)) recovered++;
      }
    }
  }
  record('no DSML markup reaches the client', leaks === 0, `${leaks} leaks over ${runs * 2} requests`);
  record('DSML is recovered into real tool_calls', recovered > 0, `${recovered} recovered responses`);
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join('; '));
process.exit(failed.length ? 1 : 0);
