import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('exits 3 with a JSON error from `hf` when the gateway is unreachable', async () => {
    const r = await runCli(['hf', '--json'], { MODELHITCH_BASE_URL: 'http://127.0.0.1:9' });
    assert.equal(r.code, 3, `want exit 3, got ${r.code}: ${r.stdout} ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
    assert.match(doc.error, /Cannot reach ModelHitch/);
  });

  it('exits 2 on an unknown tier for `hf`', async () => {
    const r = await runCli(['hf', '--tier', 'ultra', '--json'], { MODELHITCH_BASE_URL: 'http://127.0.0.1:9' });
    assert.equal(r.code, 2, `want exit 2, got ${r.code}: ${r.stdout} ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });

  it('prints `hf` help without asking the gateway anything', async () => {
    // `--help` reaches a handler as a positional, so a handler that looks for a
    // `help` flag instead runs the command for real.
    for (const arg of ['--help', 'help']) {
      const r = await runCli(['hf', arg], { MODELHITCH_BASE_URL: 'http://127.0.0.1:9' });
      assert.equal(r.code, 0, `want exit 0 for \`hf ${arg}\`, got ${r.code}: ${r.stderr}`);
      assert.match(r.stdout, /zstack hf — what the HuggingFace lane's filter does/);
    }
  });

  // The lane decides which models zstack pins, so the report that explains that
  // decision is worth driving for real. A loopback stub serves the catalogue, so
  // this runs offline: the stub advertises no HuggingFace key, which is also the
  // offline path — the filter then decides on curation rules alone and fetches
  // no capability metadata.
  it('reports the HuggingFace filter from a served catalogue, offline', async () => {
    const catalogue = [
      'huggingface/deepseek-ai/DeepSeek-V4-Pro',
      'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813',
      'huggingface/zai-org/GLM-5.3',
      'huggingface/zai-org/GLM-5.3-FP8',
      'huggingface/meta-llama/Llama-Guard-4-12B',
      'huggingface/Sao10K/L3-8B-Stheno-v3.2',
      'huggingface/thinkingmachines/Inkling',
      'huggingface/Qwen/Qwen2.5-Coder-7B-Instruct',
      'opencode/deepseek-v4-pro'
    ];
    const gateway = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = url.pathname === '/v1/config'
        // `deepseek` only: no HuggingFace key, so no capability fetch leaves the machine.
        ? { keys: { deepseek: 'x' }, defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }
        : { object: 'list', data: catalogue.map((id) => ({ id, object: 'model', owned_by: id.split('/')[0] })) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      const r = await runCli(['hf', '--tier', 'med-high', '--json'], {
        MODELHITCH_BASE_URL: `http://127.0.0.1:${gateway.address().port}`
      });
      assert.equal(r.code, 0, `want exit 0, got ${r.code}: ${r.stdout} ${r.stderr}`);
      const doc = JSON.parse(r.stdout);
      assert.equal(doc.ok, true);
      assert.equal(doc.command, 'hf');
      assert.equal(doc.tier, 'med-high');
      assert.equal(doc.keyPresent, false);

      // Only HuggingFace ids are considered, so the non-HF entry is not counted.
      assert.equal(doc.considered, 8);
      assert.equal(doc.filter.admitted + doc.filter.rejected, doc.considered);
      assert.equal(doc.filter.capabilitySource, 'unavailable');
      assert.ok(doc.filter.rejectedByGate.curation >= 3, 'guard, roleplay, and unknown-publisher models must be dropped');
      assert.ok(doc.filter.rejectedByGate.duplicate >= 2, 'the dated snapshot and the FP8 build must collapse');
      assert.equal(doc.filter.rejectedByGate.size, 1, 'the 7B build is below the med-high floor');

      const rejected = (id) => doc.filter.exclusions.find((e) => e.id === id);
      assert.ok(rejected('huggingface/meta-llama/Llama-Guard-4-12B'));
      assert.equal(rejected('huggingface/thinkingmachines/Inkling').reason, 'unrecognized publisher: thinkingmachines');
      assert.match(rejected('huggingface/zai-org/GLM-5.3-FP8').reason, /same model as huggingface\/zai-org\/GLM-5\.3/);
      assert.match(rejected('huggingface/Qwen/Qwen2.5-Coder-7B-Instruct').reason, /below the med-high floor/);

      // Every role it would pin must be a model the stub actually serves.
      for (const id of [doc.lane.coder, doc.lane.fast, doc.lane.architect, doc.lane.reasoner, ...doc.lane.panel]) {
        assert.match(id, /^huggingface\//);
        assert.ok(catalogue.includes(id), `pinned ${id}, which the catalogue does not serve`);
      }
    } finally {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
  });

  it('says the lane cannot resolve when the gateway serves no HuggingFace models', async () => {
    const gateway = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = url.pathname === '/v1/config'
        ? { keys: { deepseek: 'x' }, defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }
        : { object: 'list', data: [{ id: 'deepseek/deepseek-v4-flash', object: 'model', owned_by: 'deepseek' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      const r = await runCli(['hf'], { MODELHITCH_BASE_URL: `http://127.0.0.1:${gateway.address().port}` });
      assert.equal(r.code, 1, `want exit 1, got ${r.code}: ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, /serves no HuggingFace models/);
      assert.match(r.stderr, /HF_TOKEN/);
    } finally {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
  });

  it('routes diagnostics to stderr under --json', async () => {
    const r = await runCli(['principles', '--json']);
    assert.equal(r.code, 0, r.stderr);
    JSON.parse(r.stdout); // stdout must be pure JSON
  });

  it('keeps serve alive after stdin closes, idle time, and a gateway timeout', { timeout: 15000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zstack-serve-cli-'));
    // Accept gateway requests without answering, so the real timeout fires.
    const gateway = createServer(() => {});
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--json'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MODELHITCH_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
        MODELHITCH_TIMEOUT: '30',
        ZSTACK_HISTORY_PATH: join(dir, 'history.jsonl'),
        ZSTACK_PROJECTS_PATH: join(dir, 'projects.json'),
        ZSTACK_OVERRIDES_PATH: join(dir, 'overrides.json'),
        ZSTACK_CHATS_PATH: join(dir, 'chats.json'),
        ZSTACK_GITHUB_PATH: join(dir, 'github.json'),
        ZSTACK_SCHEDULES_PATH: join(dir, 'schedules.json')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once('close', resolve));
    try {
      const started = await new Promise((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => reject(new Error(`serve never became ready: ${stderr}`)), 5000);
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited early (${code}): ${stderr}`));
        });
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (!stdout.includes('\n')) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (err) { reject(err); }
        });
      });
      child.stdin.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(child.exitCode, null, stderr);
      const status = await fetch(`${started.url}api/status`, { signal: AbortSignal.timeout(5000) });
      const failure = await status.json();
      assert.equal(failure.connected, false);
      assert.match(JSON.stringify(failure), /timed out|timeout/i);
      const health = await fetch(`${started.url}api/health`, { signal: AbortSignal.timeout(5000) });
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      assert.equal(child.exitCode, null, stderr);
    } finally {
      child.kill('SIGTERM');
      await exited;
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
