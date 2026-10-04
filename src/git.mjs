/**
 * Git work: pull, merge, commit on a workspace directory.
 *
 * A run executes in a local clone, so the work it leaves behind is a git
 * working tree. These operations are what a reader does by hand after (or
 * before) a run: update the clone, take a branch in, put the changes on the
 * record. They are deliberately the safe set — pull is ff-only, commit
 * stages what is there and never pushes — because the reader can always go
 * to the terminal for anything sharper.
 *
 * Git is driven through `execFile` with argument arrays (never a shell
 * string), in the workspace directory, with a timeout and a bounded buffer,
 * so a command's own words come back rather than a hung server.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** One git call, or a structured failure. */
export function runGit(dir, args, { execFileImpl = execFile, timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      'git',
      args,
      { cwd: dir, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          const wrapped = new Error('Git is not installed or not on PATH.');
          wrapped.kind = 'git-unavailable';
          rejectPromise(wrapped);
          return;
        }
        if (err && err.killed) {
          const wrapped = new Error(`git ${args[0]} timed out after ${timeoutMs}ms.`);
          wrapped.kind = 'git-timeout';
          rejectPromise(wrapped);
          return;
        }
        if (err) {
          // A real git refusal (a dirty-tree merge, a non-ff pull): git's
          // stderr is the explanation, so it travels with the error.
          const wrapped = new Error(
            (String(stderr) || String(err.message) || `git ${args.join(' ')} failed.`).trim()
          );
          wrapped.kind = 'git-failed';
          wrapped.exitCode = typeof err.code === 'number' ? err.code : null;
          wrapped.output = String(stderr || '').trim();
          rejectPromise(wrapped);
          return;
        }
        resolvePromise({ exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/** A branch name is data, not a command: conservative charset, no leading dash. */
function branchProblem(branch) {
  if (typeof branch !== 'string' || branch.trim() === '') return 'A merge needs a branch.';
  if (!/^[\w][\w./-]*$/.test(branch.trim()) || branch.includes('..') || branch.trim().split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    return `"${branch}" is not a usable branch name.`;
  }
  return null;
}

/** Parse `## main...origin/main [ahead 1, behind 2]` plus the porcelain lines. */
function parseStatus(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = lines.shift() || '';
  const branchMatch = /^## (\S+?)(?:\.\.\.(\S+))?(?:\s|$)/.exec(head);
  const ahead = /ahead (\d+)/.exec(head);
  const behind = /behind (\d+)/.exec(head);
  const CAP = 200;
  const changes = lines.slice(0, CAP).map((line) => ({
    // e.g. `M  src/a.js`, `?? new.txt` — two status columns then the path.
    status: line.slice(0, 2).trim(),
    path: line.slice(3)
  }));
  return {
    branch: head.startsWith('## No commits yet on ') ? head.slice(21) : head.startsWith('## HEAD ') ? '(detached)' : branchMatch?.[1] || '(detached)',
    tracking: branchMatch?.[2] || null,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    clean: lines.length === 0,
    changed: lines.length,
    changes,
    changesTruncated: lines.length > CAP || undefined
  };
}

/**
 * Resolve subdirectories and filesystem aliases to the working tree root.
 */
export async function canonicalGitRoot(dir, options = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    const err = new Error('A git operation needs a directory.');
    err.kind = 'git-invalid';
    throw err;
  }
  const workDir = resolve(dir.trim());
  if (!existsSync(workDir)) {
    const err = new Error(`"${workDir}" does not exist.`);
    err.kind = 'git-invalid';
    throw err;
  }
  const inside = await runGit(workDir, ['rev-parse', '--is-inside-work-tree'], options);
  if (inside.stdout.trim() !== 'true') {
    const err = new Error(`"${workDir}" is not a git repository.`);
    err.kind = 'git-invalid';
    throw err;
  }

  const root = await runGit(workDir, ['rev-parse', '--show-toplevel'], options);
  const canonical = realpathSync(root.stdout.trim());
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

const operations = new Map();

export async function gitOp(dir, input = {}, options = {}) {
  if (!input || !['status', 'pull', 'merge', 'commit'].includes(input.op)) {
    throw Object.assign(new Error('Valid git operations: status, pull, merge, commit.'), { kind: 'git-invalid' });
  }
  if (input.op === 'merge') {
    const problem = branchProblem(input.branch);
    if (problem) throw Object.assign(new Error(problem), { kind: 'git-invalid' });
  }
  if (input.op === 'commit' && (typeof input.message !== 'string' || !input.message.trim() || input.message.includes('\0'))) {
    throw Object.assign(new Error('A commit needs a non-empty message without NUL characters.'), { kind: 'git-invalid' });
  }
  const workDir = await canonicalGitRoot(dir, options);
  const previous = operations.get(workDir) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    if (input.op !== 'status') await options.beforeMutation?.(workDir);
    return performGitOp(workDir, input, options);
  });
  operations.set(workDir, pending);
  try { return await pending; }
  finally { if (operations.get(workDir) === pending) operations.delete(workDir); }
}

async function performGitOp(workDir, input, options) {
  const op = input.op;
  if (op === 'status') {
    const res = await runGit(workDir, ['status', '--porcelain=v1', '-b'], options);
    return { op, status: parseStatus(res.stdout) };
  }

  const state = await runGit(workDir, ['status', '--porcelain=v1'], options);
  const gitDir = await runGit(workDir, ['rev-parse', '--absolute-git-dir'], options);
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some((name) => existsSync(resolve(gitDir.stdout.trim(), name))) ||
      /^(UU|AA|DD|AU|UA|DU|UD) /m.test(state.stdout)) {
    throw Object.assign(new Error('Resolve the existing conflict or in-progress Git operation in the terminal first.'), { kind: 'git-conflict' });
  }
  if ((op === 'pull' || op === 'merge') && state.stdout.trim()) {
    throw Object.assign(new Error('Pull and merge require a clean working tree, including untracked files.'), { kind: 'git-dirty' });
  }

  if (op === 'pull') {
    // ff-only: a divergence is refused by git with its own explanation
    // rather than resolved into a merge nobody asked for.
    const res = await runGit(workDir, ['-c', 'merge.autostash=false', '-c', 'rebase.autostash=false', 'pull', '--ff-only', '--no-rebase'], options);
    return { op, output: (res.stdout + res.stderr).trim() || 'Already up to date.' };
  }

  if (op === 'merge') {
    const branch = input.branch.trim();
    // The fetch and the merge are separate calls, so a fetch failure names
    // the remote rather than surfacing as a confusing merge error.
    if (branch.startsWith('origin/')) await runGit(workDir, ['fetch', 'origin'], options);
    let res;
    try {
      res = await runGit(workDir, ['-c', 'merge.autostash=false', 'merge', '--no-edit', '--no-autostash', branch], options);
    } catch (err) {
      if (existsSync(resolve(gitDir.stdout.trim(), 'MERGE_HEAD'))) {
        try { await runGit(workDir, ['merge', '--abort'], options); }
        catch (abortError) { throw Object.assign(new Error(`${err.message}\nMerge abort failed: ${abortError.message}. Resolve in the terminal.`), { kind: 'git-conflict' }); }
      }
      throw err;
    }
    return { op, output: (res.stdout + res.stderr).trim() || 'Merged.' };
  }

  if (op === 'commit') {
    const message = input.message.trim();
    if (state.stdout.trim() === '') {
      // Nothing to commit is not a failure: it is the answer.
      return { op, nothing: true, output: 'Nothing to commit: the working tree is clean.' };
    }
    await runGit(workDir, ['add', '--all'], options);
    await runGit(workDir, ['commit', '--message', message], options);
    const sha = await runGit(workDir, ['rev-parse', '--short', 'HEAD'], options);
    const after = await runGit(workDir, ['status', '--porcelain=v1'], options);
    return {
      op,
      sha: sha.stdout.trim(),
      message,
      clean: after.stdout.trim() === '',
      output: `Committed ${sha.stdout.trim()} — ${message}`
    };
  }

  const err = new Error(`Unknown git op "${String(op)}". Valid: status, pull, merge, commit.`);
  err.kind = 'git-invalid';
  throw err;
}

/**
 * Ensure a feature branch exists, commit uncommitted changes if any, and push to remote.
 * Used for automated PR flows.
 */
export async function commitAndPushBranch(dir, { branch, message = 'zstack update', remote = 'origin' } = {}, options = {}) {
  const workDir = await canonicalGitRoot(dir, options);
  if (typeof branch !== 'string' || !branch.trim()) {
    throw Object.assign(new Error('A branch name is required.'), { kind: 'git-invalid' });
  }
  const cleanBranch = branch.trim();
  const problem = branchProblem(cleanBranch);
  if (problem) throw Object.assign(new Error(problem), { kind: 'git-invalid' });

  const remotesRes = await runGit(workDir, ['remote'], options);
  const remotes = remotesRes.stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw Object.assign(new Error(`Git remote "${remote}" does not exist.`), { kind: 'git-remote-missing' });
  }

  // Check current branch
  const statusRes = await runGit(workDir, ['status', '--porcelain=v1', '-b'], options);
  const status = parseStatus(statusRes.stdout);

  // If not on target branch, create or switch to it
  if (status.branch !== cleanBranch) {
    try {
      await runGit(workDir, ['checkout', cleanBranch], options);
    } catch {
      await runGit(workDir, ['checkout', '-b', cleanBranch], options);
    }
  }

  // Check if there are changes to commit
  const state = await runGit(workDir, ['status', '--porcelain=v1'], options);
  let committed = false;
  let sha = null;
  if (state.stdout.trim() !== '') {
    await runGit(workDir, ['add', '--all'], options);
    await runGit(workDir, ['commit', '--message', message.trim() || 'zstack update'], options);
    const shaRes = await runGit(workDir, ['rev-parse', '--short', 'HEAD'], options);
    sha = shaRes.stdout.trim();
    committed = true;
  } else {
    const shaRes = await runGit(workDir, ['rev-parse', '--short', 'HEAD'], options);
    sha = shaRes.stdout.trim();
  }

  // Push branch to remote
  const pushRes = await runGit(workDir, ['push', '-u', remote, cleanBranch], options);

  return {
    branch: cleanBranch,
    sha,
    committed,
    pushed: true,
    output: (pushRes.stdout + pushRes.stderr).trim()
  };
}

