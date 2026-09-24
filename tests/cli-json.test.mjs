import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'bin', 'zstack.mjs');

const run = promisify(execFile);

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env }
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('structured JSON CLI output', () => {
  it('emits parseable JSON for playbooks', async () => {
    const r = await runCli(['playbooks', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.ok(Array.isArray(doc.playbooks) && doc.playbooks.length > 0);
  });

  it('exits 2 with a JSON error on usage errors', async () => {
    const r = await runCli(['task', '--json']);
    assert.equal(r.code, 2, `want exit 2, got ${r.code}: ${r.stdout} ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
    assert.ok(typeof doc.error === 'string' && doc.error.length > 0);
  });

  it('exits 2 with a JSON error on unknown flag-like commands', async () => {
    const r = await runCli(['--frobnicate', '--json']);
    assert.equal(r.code, 2, `want exit 2, got ${r.code}: ${r.stdout} ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
  });

  it('exits 3 with a JSON error when the gateway is unreachable', async () => {
    const r = await runCli(['status', '--json'], { MODELHITCH_BASE_URL: 'http://127.0.0.1:9' });
    assert.equal(r.code, 3, `want exit 3, got ${r.code}: ${r.stdout} ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
  });

  it('routes diagnostics to stderr under --json', async () => {
    const r = await runCli(['principles', '--json']);
    assert.equal(r.code, 0, r.stderr);
    JSON.parse(r.stdout); // stdout must be pure JSON
  });
});
