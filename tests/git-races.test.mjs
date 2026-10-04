import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/serve.mjs';
import { createLiveRun, liveRunToPage } from '../src/blocks.mjs';
import { writeGitHubStore } from '../src/github.mjs';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'zstack-git-race-')); dirs.push(dir); return dir; }
function git(dir, ...args) { execFileSync('git', args, { cwd: dir, stdio: 'pipe' }); }
function repo() {
  const dir = temp(); git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'initial.txt'), 'initial'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'initial');
  return dir;
}
function gate(predicate) {
  let armed = true; let release;
  const entered = new Promise((resolve) => { release = resolve; });
  return {
    entered,
    exec(file, args, options, callback) {
      if (armed && predicate(args, options)) {
        armed = false;
        release(() => execFile(file, args, options, callback));
      } else execFile(file, args, options, callback);
    }
  };
}
async function boot(dir, executor, extraRun) {
  const base = temp(); const sub = join(dir, 'sub'); mkdirSync(sub);
  const run = createLiveRun({ id: 'previous', workspaceDir: sub });
  run.sessionId = 'saved'; run.maxTurns = 25;
  let active = false; let activations = 0;
  const activate = () => { active = true; activations++; return run; };
  const registry = {
    shutdown() {}, get: (id) => id === run.id ? run : extraRun?.id === id ? extraRun : null,
    getPage: (id) => id === run.id ? liveRunToPage(run) : null,
    listLive: () => [...(active ? [{ id: run.id, live: true }] : []), ...(extraRun ? [{ id: extraRun.id, live: true }] : [])],
    start: activate, resume: activate, continueRun: activate
  };
  const githubPath = join(base, 'github.json');
  writeGitHubStore(githubPath, { repos: [{ fullName: 'test/repo', localPath: dir }] });
  const server = await startServer({ port: 0, registry, githubPath, gitExecFile: executor,
    projectsPath: join(base, 'projects.json'), historyPath: join(base, 'history.jsonl'), overridesPath: join(base, 'overrides.json'),
    zstack: { listPlaybooks: () => [], listPrinciples: () => [] }
  });
  const request = (path, body) => fetch(`${server.url}api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return {
    sub, request, activations: () => activations,
    mutation: () => request('/github/git', { fullName: 'test/repo', op: 'commit', message: 'whole tree' }),
    action: (kind) => kind === 'start'
      ? request('/runs', { prompt: 'work', workspaceDir: sub })
      : request(`/runs/previous/${kind}`, { maxTurns: 60 }),
    close: () => new Promise((resolve) => server.server.close(resolve))
  };
}

for (const kind of ['start', 'resume', 'continue']) {
  test(`${kind} refuses an in-flight mutation and succeeds after its reservation releases`, { timeout: 20000 }, async () => {
    const dir = repo(); writeFileSync(join(dir, 'change.txt'), 'change');
    const hold = gate((args) => args[0] === 'commit'); const s = await boot(dir, hold.exec);
    let release;
    try {
      const mutation = s.mutation(); release = await hold.entered;
      const refused = await s.action(kind);
      assert.equal(refused.status, 409); assert.match((await refused.json()).error, /mutation.*in flight/);
      assert.equal(s.activations(), 0);
      release(); release = null; assert.equal((await mutation).status, 200);
      assert.equal((await s.action(kind)).status, 202); assert.equal(s.activations(), 1);
      assert.equal((await s.mutation()).status, 409);
    } finally { release?.(); await s.close(); }
  });

  test(`${kind} reserves admission before root resolution; concurrent mutation cannot pass`, { timeout: 20000 }, async () => {
    const dir = repo(); const sub = join(dir, 'sub');
    const hold = gate((args, options) => args.includes('--show-toplevel') && options.cwd === sub);
    const s = await boot(dir, hold.exec); let release;
    try {
      const admission = s.action(kind); release = await hold.entered;
      const refused = await s.mutation();
      assert.equal(refused.status, 409); assert.match((await refused.json()).error, /being admitted/);
      assert.equal(s.activations(), 0);
      release(); release = null; assert.equal((await admission).status, 202);
      assert.equal(s.activations(), 1);
      assert.equal((await s.mutation()).status, 409);
    } finally { release?.(); await s.close(); }
  });
}

test('mutation reserves its root before asynchronous active-run checks; a stale snapshot cannot admit a new run', { timeout: 20000 }, async () => {
  const dir = repo(); const other = repo();
  const extraRun = createLiveRun({ id: 'other', workspaceDir: other });
  const hold = gate((args, options) => args.includes('--show-toplevel') && options.cwd === other);
  const s = await boot(dir, hold.exec, extraRun); let release;
  try {
    const mutation = s.mutation(); release = await hold.entered;
    for (const kind of ['start', 'resume', 'continue']) assert.equal((await s.action(kind)).status, 409);
    assert.equal(s.activations(), 0);
    release(); release = null; assert.equal((await mutation).status, 200);
    assert.equal((await s.action('start')).status, 202);
  } finally { release?.(); await s.close(); }
});
