import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'bin', 'zstack.mjs');

const run = promisify(execFile);

function runShellPiped(input, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'shell'], {
      cwd: ROOT,
      env: { ...process.env, ZSTACK_SHELL_FORCE: '1', ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout, stderr, error: err.message }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe('interactive z-mode shell', () => {
  it('runs slash commands and exits 0 on /exit', async () => {
    const r = await runShellPiped('/help\n/playbook bug-fix\n/exit\n');
    assert.equal(r.code, 0, `want exit 0, got ${r.code}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes('Session commands'), 'must print session help');
    assert.ok(r.stdout.includes('playbook: bug-fix'), 'must confirm sticky playbook');
  });

  it('ignores empty lines and survives unknown slash commands', async () => {
    const r = await runShellPiped('/bogus\n\n   \n/exit\n');
    assert.equal(r.code, 0, `want exit 0, got ${r.code}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes('Unknown session command'), 'must flag unknown commands');
    assert.ok(r.stdout.includes('Session commands'), 'must reprint help and stay alive');
  });

  it('supports repl alias and sticky json/status commands', async () => {
    const r = await new Promise(resolve => {
      const child = spawn(process.execPath, [CLI, 'repl'], {
        cwd: ROOT,
        env: { ...process.env, ZSTACK_SHELL_FORCE: '1' }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.write('/json on\n/status\n/json off\n/exit\n');
      child.stdin.end();
    });
    assert.equal(r.code, 0, `want exit 0, got ${r.code}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes('json: on'), 'must toggle json mode');
    assert.ok(r.stdout.includes('Session state:'), 'must print session state');
  });

  it('refuses to start on non-TTY stdin without the force override', async () => {
    try {
      await run(process.execPath, [CLI, 'shell'], {
        cwd: ROOT,
        env: { ...process.env, ZSTACK_SHELL_FORCE: '' }
      });
      assert.fail('must exit non-zero on non-TTY stdin');
    } catch (err) {
      assert.equal(err.code, 2, `want exit 2, got ${err.code}: ${err.stdout} ${err.stderr}`);
      assert.match(err.stderr || err.stdout || '', /interactive terminal/);
    }
  });
});
