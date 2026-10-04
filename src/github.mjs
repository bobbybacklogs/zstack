/**
 * GitHub repos: a synced catalogue the composer picks a workspace from.
 *
 * A run executes in a local directory, so a GitHub repo only becomes a
 * workspace through its local clone. The sync fetches the repo list with a
 * personal access token, guesses where each repo is cloned (probing a few
 * conventional locations, because the guess is only a starting point — the
 * path is editable per repo), and stores the catalogue in a JSON file next
 * to projects, written atomically for the same reason.
 *
 * The sync is manual on purpose: no polling, no webhooks. The repo page has a
 * sync button and the reader presses it when they want fresh state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit } from './git.mjs';

/** Where the synced catalogue lives. */
export function githubPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_GITHUB_PATH ||
    join(homedir(), '.zstack', 'github.json')
  );
}

/** Where clones are assumed to live when nothing better is known. */
export function defaultBaseDir() {
  return process.env.ZSTACK_GITHUB_CLONE_BASE || join(homedir(), 'Documents', 'GitHub');
}

/**
 * Conventional clone locations, probed in order before falling back to the
 * base dir. OneDrive redirection moves `Documents` on Windows machines, so
 * both spellings are probed; the rest are the usual suspects.
 */
export const CLONE_CANDIDATE_DIRS = [
  'Documents/GitHub',
  'OneDrive/Documents/GitHub',
  'dev',
  'repos',
  'src',
  'Projects',
  'code'
];

/**
 * Parse a `.env` file into a flat map.
 *
 * Comments (`#`), blank lines, and `export ` prefixes are skipped; values may
 * be single- or double-quoted. Nothing is evaluated, so a `.env` file is data,
 * not code.
 */
export function parseDotEnv(text) {
  const map = {};
  if (typeof text !== 'string') return map;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const stripped = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    // A quoted value ends at its closing quote, so anything after it — a
    // trailing comment included — is dropped rather than parsed. An unquoted
    // value ends at a ` #` comment. Anything else is taken whole.
    const quote = value === '' ? null : (value[0] === '"' || value[0] === "'" ? value[0] : null);
    if (quote) {
      const close = value.indexOf(quote, 1);
      if (close > 0) value = value.slice(1, close);
    } else {
      const hash = value.indexOf(' #');
      if (hash > 0) value = value.slice(0, hash).trim();
    }
    if (key !== '') map[key] = value;
  }
  return map;
}

/**
 * The GitHub token, from the environment or a `.env` file in the working
 * directory.
 *
 * A real environment variable always wins, so an exported token beats a
 * stale one in the file. The token is never returned to a client; callers
 * only learn whether one exists.
 */
export function readGitHubToken(env = process.env, dotEnvFile = join(process.cwd(), '.env')) {
  if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== '') return env.GITHUB_TOKEN.trim();
  if (env.GH_TOKEN && env.GH_TOKEN.trim() !== '') return env.GH_TOKEN.trim();
  try {
    const fromFile = parseDotEnv(readFileSync(dotEnvFile, 'utf8'));
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      if (fromFile[key] && fromFile[key].trim() !== '') return fromFile[key].trim();
    }
  } catch {
    // No .env file, or one that cannot be read: the token is simply absent.
  }
  return null;
}

/**
 * The gh CLI's token, as a third source.
 *
 * An already-authenticated gh CLI answers `gh auth token`, so a machine with
 * gh set up needs no `.env` at all. The answer is cached for the process,
 * both ways, per executor, including an in-flight lookup. A page view
 * should not spawn another CLI. A reset hook covers tests and a login that
 * happened while the server was running.
 */
let ghTokenCache = new WeakMap();

export function resetGhAuthCache() {
  ghTokenCache = new WeakMap();
}

export function ghAuthToken({ execFileImpl = execFile } = {}) {
  if (ghTokenCache.has(execFileImpl)) return ghTokenCache.get(execFileImpl);
  const pending = new Promise((resolveToken) => {
    execFileImpl('gh', ['auth', 'token'], { timeout: 5000, maxBuffer: 65536, windowsHide: true }, (err, stdout) => {
      resolveToken(err ? null : (String(stdout || '').trim() || null));
    });
  });
  ghTokenCache.set(execFileImpl, pending);
  return pending;
}

/**
 * The best guess for where a repo is cloned locally.
 *
 * Each conventional location is probed for a directory named like the repo;
 * the first hit wins. With no hit the guess is the base dir, which the repo
 * page and the picker both show as editable rather than as a promise.
 */
export function guessLocalPath(name, baseDir = defaultBaseDir()) {
  for (const candidate of CLONE_CANDIDATE_DIRS) {
    const dir = join(homedir(), candidate, name);
    if (existsSync(dir)) return dir;
  }
  return join(baseDir, name);
}

/**
 * The canonical shape of one synced repo.
 *
 * `cloned` is recomputed from disk rather than stored, so it cannot drift:
 * a repo cloned after the last sync reads as cloned without a re-sync.
 */
export function repoRecord(raw, baseDir = defaultBaseDir()) {
  const name = String(raw.name || '');
  const localPath = typeof raw.localPath === 'string' && raw.localPath.trim() !== ''
    ? resolve(raw.localPath)
    : guessLocalPath(name, baseDir);
  return {
    id: String(raw.id ?? ''),
    name,
    fullName: String(raw.fullName || raw.full_name || raw.name || ''),
    private: raw.private === true,
    cloneUrl: String(raw.cloneUrl || raw.clone_url || ''),
    htmlUrl: String(raw.htmlUrl || raw.html_url || ''),
    defaultBranch: String(raw.defaultBranch || raw.default_branch || ''),
    updatedAt: String(raw.updatedAt || raw.updated_at || ''),
    localPath,
    cloned: existsSync(localPath)
  };
}

/** Read the catalogue, tolerating a missing or corrupted file like projects do. */
export function readGitHubStore(pathOverride) {
  const file = githubPath(pathOverride);
  if (!existsSync(file)) {
    return { login: null, syncedAt: null, baseDir: defaultBaseDir(), repos: [], corrupted: false, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { login: null, syncedAt: null, baseDir: defaultBaseDir(), repos: [], corrupted: true, path: file };
  }
  const list = Array.isArray(parsed?.repos) ? parsed.repos : [];
  const baseDir = typeof parsed?.baseDir === 'string' && parsed.baseDir !== ''
    ? parsed.baseDir
    : defaultBaseDir();
  return {
    login: typeof parsed?.login === 'string' ? parsed.login : null,
    syncedAt: typeof parsed?.syncedAt === 'string' ? parsed.syncedAt : null,
    baseDir,
    // `cloned` is recomputed, so a stale file cannot claim a clone that is gone.
    repos: list
      .filter((r) => r && typeof r === 'object' && typeof r.fullName === 'string' && r.fullName !== '')
      .map((r) => repoRecord(r, baseDir)),
    corrupted: false,
    path: file
  };
}

function writeStore(file, store) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ version: 1, ...store }, null, 2) + '\n',
    'utf8'
  );
  renameSync(tmp, file);
}

export function writeGitHubStore(pathOverride, store) {
  const file = githubPath(pathOverride);
  writeStore(file, store);
  return file;
}

/**
 * Merge a fresh fetch into the stored catalogue.
 *
 * The fetch is authoritative about what exists; the store is authoritative
 * about what the reader edited. So a stored `localPath` survives a re-sync
 * while its directory still exists — once the clone is gone the guess runs
 * again, because a path that points nowhere helps nobody picking a workspace.
 */
export function mergeRepos(existing, fetched, baseDir = defaultBaseDir()) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const byName = new Map(existing.map((r) => [r.fullName.toLowerCase(), r]));
  return fetched.map((raw) => {
    const prior = byId.get(String(raw.id)) || byName.get(String(raw.fullName || '').toLowerCase());
    if (prior && existsSync(prior.localPath)) {
      return repoRecord({ ...raw, localPath: prior.localPath }, baseDir);
    }
    return repoRecord(raw, baseDir);
  });
}

/**
 * Fetch the user's repos from the GitHub API.
 *
 * Paginated (`per_page=100`, up to `MAX_PAGES` pages), owner and collaborator
 * affiliations, newest update first. The `fetch` implementation is injectable
 * so tests drive the merge and the endpoints without the network.
 */
export const GITHUB_MAX_PAGES = 5;

export async function fetchGitHubRepos({ token, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  if (!token) {
    const err = new Error('No GitHub token. Set GITHUB_TOKEN in .env or the environment.');
    err.kind = 'github-no-token';
    throw err;
  }
  const repos = [];
  let login = null;
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const url = `https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc&affiliation=owner,collaborator&page=${page}`;
    let res;
    try {
      res = await doFetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        }
      });
    } catch (err) {
      const wrapped = new Error(`GitHub is unreachable: ${err.message}`);
      wrapped.kind = 'github-unreachable';
      throw wrapped;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error('GitHub refused the token (401/403). Check GITHUB_TOKEN scopes and expiry.');
      err.kind = 'github-unauthorized';
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`GitHub API failed with ${res.status}.`);
      err.kind = 'github-http';
      throw err;
    }
    let batch;
    try {
      batch = await res.json();
    } catch {
      const err = new Error('GitHub API returned a body that is not JSON.');
      err.kind = 'github-parse';
      throw err;
    }
    if (!Array.isArray(batch)) {
      const err = new Error('GitHub API returned something other than a repo list.');
      err.kind = 'github-parse';
      throw err;
    }
    if (batch.length === 0) break;
    for (const raw of batch) {
      if (login === null && raw?.owner?.login) login = String(raw.owner.login);
      repos.push({
        id: String(raw.id ?? ''),
        name: String(raw.name || ''),
        fullName: String(raw.full_name || ''),
        private: raw.private === true,
        cloneUrl: String(raw.clone_url || ''),
        htmlUrl: String(raw.html_url || ''),
        defaultBranch: String(raw.default_branch || ''),
        updatedAt: String(raw.updated_at || '')
      });
    }
    if (batch.length < 100) break;
  }
  return { login, repos };
}

/**
 * Extract owner, repo, and full name from a GitHub remote URL.
 * Handles HTTPS, SSH, and optional .git extensions.
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null;
  const match = url.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

/**
 * Create a GitHub pull request.
 * Tries `gh pr create` via CLI first if available/authenticated; falls back to GitHub REST API.
 */
export async function createPullRequest({
  dir,
  title,
  body = '',
  head,
  base,
  token,
  execFileImpl = execFile,
  fetchImpl
} = {}) {
  if (!dir) throw Object.assign(new Error('A directory is required to create a PR.'), { kind: 'github-invalid' });
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw Object.assign(new Error('A PR title is required.'), { kind: 'github-invalid' });
  }
  if (!head || typeof head !== 'string' || !head.trim()) {
    throw Object.assign(new Error('A head branch is required for a PR.'), { kind: 'github-invalid' });
  }

  // 1. Try `gh pr create` first
  const ghPrArgs = ['pr', 'create', '--title', title.trim(), '--body', body, '--head', head.trim()];
  if (base && typeof base === 'string' && base.trim()) {
    ghPrArgs.push('--base', base.trim());
  }

  const ghResult = await new Promise((resolvePr) => {
    execFileImpl('gh', ghPrArgs, { cwd: dir, timeout: 30000, maxBuffer: 65536, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolvePr({ ok: false, error: err, stderr: String(stderr || '') });
      } else {
        const out = String(stdout || '').trim();
        const urlMatch = out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
        resolvePr({ ok: true, url: urlMatch ? urlMatch[0] : out });
      }
    });
  });

  if (ghResult.ok && ghResult.url) {
    return { ok: true, url: ghResult.url, method: 'gh' };
  }

  // 2. Fallback to GitHub REST API
  let remoteUrl = null;
  try {
    const gitRemote = await runGit(dir, ['remote', 'get-url', 'origin'], { execFileImpl });
    remoteUrl = gitRemote.stdout.trim();
  } catch {
    // remote origin might be missing
  }

  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    const reason = ghResult.stderr ? `: ${ghResult.stderr}` : '';
    throw Object.assign(
      new Error(`Could not determine GitHub repository for remote URL "${remoteUrl || 'none'}"${reason}`),
      { kind: 'github-remote' }
    );
  }

  const authToken = token || readGitHubToken() || (await ghAuthToken({ execFileImpl }));
  if (!authToken) {
    throw Object.assign(
      new Error('No GitHub token. Set GITHUB_TOKEN in .env or the environment, or log in with gh CLI.'),
      { kind: 'github-no-token' }
    );
  }

  let targetBase = base;
  if (!targetBase) {
    try {
      await runGit(dir, ['rev-parse', '--verify', 'main'], { execFileImpl });
      targetBase = 'main';
    } catch {
      try {
        await runGit(dir, ['rev-parse', '--verify', 'master'], { execFileImpl });
        targetBase = 'master';
      } catch {
        targetBase = 'main';
      }
    }
  }

  const doFetch = fetchImpl || fetch;
  const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`;
  let res;
  try {
    res = await doFetch(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        title: title.trim(),
        head: head.trim(),
        base: targetBase,
        body
      })
    });
  } catch (err) {
    throw Object.assign(new Error(`GitHub is unreachable: ${err.message}`), { kind: 'github-unreachable' });
  }

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('GitHub refused the token (401/403). Check GITHUB_TOKEN scopes and expiry.'), { kind: 'github-unauthorized' });
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(new Error('GitHub API returned a body that is not JSON.'), { kind: 'github-parse' });
  }

  if (!res.ok) {
    if (res.status === 422 && Array.isArray(data?.errors) && data.errors.some((e) => /pull request already exists/i.test(e.message || ''))) {
      try {
        const listUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls?head=${encodeURIComponent(`${parsed.owner}:${head.trim()}`)}&state=open`;
        const listRes = await doFetch(listUrl, {
          headers: {
            authorization: `Bearer ${authToken}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28'
          }
        });
        if (listRes.ok) {
          const pulls = await listRes.json();
          if (Array.isArray(pulls) && pulls[0]?.html_url) {
            return { ok: true, url: pulls[0].html_url, number: pulls[0].number, existing: true, method: 'api' };
          }
        }
      } catch {
        // ignore
      }
    }
    const message = data?.message || `GitHub API failed with status ${res.status}`;
    throw Object.assign(new Error(message), { kind: 'github-http', status: res.status, data });
  }

  return {
    ok: true,
    url: data.html_url,
    number: data.number,
    method: 'api'
  };
}
