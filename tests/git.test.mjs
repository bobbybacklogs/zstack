import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { gitOp, runGit, commitAndPushBranch } from '../src/git.mjs';
import { ghAuthToken, resetGhAuthCache, writeGitHubStore } from '../src/github.mjs';
import { startServer } from '../src/serve.mjs';
import { createLiveRun, liveRunToPage, projectStoredRun } from '../src/blocks.mjs';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'zstack-git-')); dirs.push(dir); return dir; }
function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function identity(dir) { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false'); }
function repo() {
  const dir = temp(); git(dir, 'init', '-b', 'main.long-name'); identity(dir);
  writeFileSync(join(dir, 'file.txt'), 'base\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'initial'); return dir;
}

test('status preserves complete branch names; commit stages the entire tree from a subdirectory', async () => {
  const dir = repo(); mkdirSync(join(dir, 'sub'));
  assert.equal((await gitOp(dir, { op: 'status' })).status.branch, 'main.long-name');
  writeFileSync(join(dir, 'unrelated.txt'), 'outside run');
  writeFileSync(join(dir, 'sub', 'run.txt'), 'run');
  const result = await gitOp(join(dir, 'sub'), { op: 'commit', message: 'all changes' });
  assert.equal(result.clean, true); assert.ok(result.sha);
  assert.match(git(dir, 'show', '--stat', 'HEAD'), /unrelated.txt/);
  assert.equal((await gitOp(dir, { op: 'commit', message: 'empty' })).nothing, true);
});

test('validation rejects unsupported ops, bad branches, empty messages and non-repositories', async () => {
  const dir = repo();
  for (const input of [null, { op: 'push' }, { op: 'merge', branch: '--evil' }, { op: 'merge', branch: 'a..b' }, { op: 'commit', message: ' ' }]) {
    await assert.rejects(gitOp(dir, input), { kind: 'git-invalid' });
  }
  await assert.rejects(gitOp(temp(), { op: 'status' }));
  await assert.rejects(gitOp('', { op: 'status' }), { kind: 'git-invalid' });
});

test('merge accepts a local branch and aborts conflicts without changing HEAD or files', async () => {
  const dir = repo(); git(dir, 'checkout', '-b', 'feature');
  writeFileSync(join(dir, 'feature.txt'), 'feature'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'feature');
  git(dir, 'checkout', 'main.long-name'); await gitOp(dir, { op: 'merge', branch: 'feature' });
  assert.equal(readFileSync(join(dir, 'feature.txt'), 'utf8'), 'feature');
  git(dir, 'checkout', '-b', 'conflict'); writeFileSync(join(dir, 'file.txt'), 'other\n'); git(dir, 'commit', '-am', 'other');
  git(dir, 'checkout', 'main.long-name'); writeFileSync(join(dir, 'file.txt'), 'ours\n'); git(dir, 'commit', '-am', 'ours');
  const head = git(dir, 'rev-parse', 'HEAD');
  await assert.rejects(gitOp(dir, { op: 'merge', branch: 'conflict' }), { kind: 'git-failed' });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(dir, 'file.txt'), 'utf8'), 'ours\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(dir, '.git', 'MERGE_HEAD')), false);
  try { git(dir, 'merge', 'conflict'); } catch {}
  await assert.rejects(gitOp(dir, { op: 'commit', message: 'conflict' }), { kind: 'git-conflict' });
  await assert.rejects(gitOp(dir, { op: 'pull' }), { kind: 'git-conflict' });
});

test('pull from a local bare remote is ff-only; dirty trees and divergence are refused', async () => {
  const source = repo(); const remote = temp(); git(remote, 'init', '--bare');
  git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main.long-name');
  const clone = temp(); git(clone, '-c', 'core.autocrlf=false', 'clone', '--branch', 'main.long-name', remote, '.'); identity(clone);
  writeFileSync(join(source, 'remote.txt'), 'remote'); git(source, 'add', '.'); git(source, 'commit', '-m', 'remote'); git(source, 'push');
  await gitOp(clone, { op: 'pull' });
  const status = (await gitOp(clone, { op: 'status' })).status;
  assert.equal(status.tracking, 'origin/main.long-name'); assert.equal(status.behind, 0);
  writeFileSync(join(clone, 'dirty.txt'), 'dirty');
  for (const op of ['pull', 'merge']) await assert.rejects(gitOp(clone, { op, branch: 'origin/main.long-name' }), { kind: 'git-dirty' });
  await gitOp(clone, { op: 'commit', message: 'local' });
  writeFileSync(join(source, 'remote.txt'), 'new'); git(source, 'commit', '-am', 'remote again'); git(source, 'push');
  const head = git(clone, 'rev-parse', 'HEAD');
  await assert.rejects(gitOp(clone, { op: 'pull' }), { kind: 'git-failed' });
  assert.equal(git(clone, 'rev-parse', 'HEAD'), head);
  await gitOp(clone, { op: 'merge', branch: 'origin/main.long-name' });
  assert.equal((await gitOp(clone, { op: 'status' })).status.clean, true);
});

test('operations serialize across root and subdirectory, and recover after refusal', async () => {
  const dir = repo(); const sub = join(dir, 'sub'); mkdirSync(sub);
  let release; const gate = new Promise((r) => { release = r; }); let entered = false;
  const first = gitOp(dir, { op: 'commit', message: 'first' }, { beforeMutation: async () => { entered = true; await gate; throw new Error('blocked'); } });
  while (!entered) await new Promise((r) => setTimeout(r, 5));
  let done = false; const second = gitOp(sub, { op: 'status' }).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50)); assert.equal(done, false);
  release(); await assert.rejects(first, /blocked/); await second; assert.equal(done, true);
});

test('subprocess unavailable and timeout errors are structured', async () => {
  for (const [error, kind] of [[{ code: 'ENOENT' }, 'git-unavailable'], [{ killed: true }, 'git-timeout']]) {
    await assert.rejects(runGit('.', ['status'], { execFileImpl: (_f, _a, _o, cb) => cb(error, '', '') }), { kind });
  }
});

test('gh fallback caches concurrent results per injected executor, including failure', async () => {
  resetGhAuthCache(); let calls = 0;
  const success = (file, args, options, cb) => { calls++; assert.equal(file, 'gh'); assert.deepEqual(args, ['auth', 'token']); assert.equal(options.timeout, 5000); setTimeout(() => cb(null, ' token\n'), 5); };
  assert.deepEqual(await Promise.all([ghAuthToken({ execFileImpl: success }), ghAuthToken({ execFileImpl: success })]), ['token', 'token']);
  assert.equal(calls, 1);
  const failure = (_f, _a, _o, cb) => cb(new Error('no credentials'), '');
  assert.equal(await ghAuthToken({ execFileImpl: failure }), null);
  assert.equal(await ghAuthToken({ execFileImpl: success }), 'token');
});

test('repo and run endpoints use recorded paths and refuse mutations during active runs', async () => {
  const dir = repo(); const base = temp(); const sub = join(dir, 'sub'); mkdirSync(sub);
  const store = join(base, 'github.json');
  writeGitHubStore(store, { repos: [{ fullName: 'test/repo', name: 'repo', localPath: dir }] });
  let active = true;
  const run = createLiveRun({ id: 'run1', workspaceDir: sub });
  const registry = { shutdown() {}, getPage: (id) => id === 'run1' ? liveRunToPage(run) : null, get: (id) => id === 'run1' ? run : null, listLive: () => active ? [{ id: 'run1', live: true }] : [] };
  writeFileSync(join(base, 'history.jsonl'), JSON.stringify({ id: 'stored1', command: 'agent', workspace: sub, ok: true }) + '\n');
  const started = await startServer({ port: 0, registry, githubPath: store, historyPath: join(base, 'history.jsonl'), projectsPath: join(base, 'projects.json'), overridesPath: join(base, 'overrides.json'), zstack: { listPlaybooks: () => [], listPrinciples: () => [] } });
  const request = (path, body) => fetch(`${started.url}api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await request('/github/git', { fullName: 'missing', op: 'status' })).status, 404);
    assert.equal((await request('/runs/missing/git', { op: 'status' })).status, 404);
    assert.equal((await request('/runs/%E0%A4%A/git', { op: 'status' })).status, 400);
    assert.equal((await request('/runs/%ZZ/git', { op: 'status' })).status, 400);
    assert.equal(projectStoredRun({ workspace: sub }).workspace, sub);
    for (const id of ['run1', 'stored1']) {
      const page = (await (await fetch(`${started.url}api/runs/${id}`)).json()).page;
      assert.equal(page.workspace, sub);
      assert.equal(page.props.find((prop) => prop.key === 'workspace').value, sub);
      assert.equal((await request(`/runs/${id}/git`, { op: 'status' })).status, 200);
    }
    for (const path of ['/github/git', '/runs/run1/git']) {
      assert.equal((await request(path, { fullName: 'test/repo', op: 'status', dir: 'ignored' })).status, 200);
      const blocked = await request(path, { fullName: 'test/repo', op: 'commit', message: 'blocked' });
      assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /active/);
    }
    active = false;
    writeFileSync(join(dir, 'all.txt'), 'all');
    assert.equal((await request('/runs/run1/git', { op: 'commit', message: 'whole tree' })).status, 200);
    writeFileSync(join(dir, 'stored.txt'), 'stored');
    assert.equal((await request('/runs/stored1/git', { op: 'commit', message: 'stored whole tree' })).status, 200);
    assert.equal((await request('/github/git', { fullName: 'test/repo', op: 'push' })).status, 400);
  } finally { await new Promise((r) => started.server.close(r)); }
});

test('commitAndPushBranch creates a branch, commits changes, and pushes to remote', async () => {
  const source = repo();
  const remote = temp();
  git(remote, 'init', '--bare');
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-u', 'origin', 'main.long-name');

  writeFileSync(join(source, 'pr-change.txt'), 'hello from pr\n');
  const res = await commitAndPushBranch(source, {
    branch: 'zstack/feature-pr-test',
    message: 'feat: automated pr changes'
  });

  assert.equal(res.branch, 'zstack/feature-pr-test');
  assert.equal(res.committed, true);
  assert.equal(res.pushed, true);

  const remoteBranches = git(remote, 'branch');
  assert.match(remoteBranches, /zstack\/feature-pr-test/);
});

