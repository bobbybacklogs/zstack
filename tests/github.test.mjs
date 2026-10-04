import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseDotEnv,
  readGitHubToken,
  guessLocalPath,
  repoRecord,
  readGitHubStore,
  writeGitHubStore,
  mergeRepos,
  fetchGitHubRepos,
  parseGitHubRemote,
  createPullRequest,
  GITHUB_MAX_PAGES
} from '../src/github.mjs';
import { startServer } from '../src/serve.mjs';
import { readProjects } from '../src/projects.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'zstack-gh-'));
}

/* ------------------------------------------------------------ dot env / token */

describe('github .env parsing', () => {
  it('parses keys, quotes, comments, and export prefixes', () => {
    const map = parseDotEnv([
      '# a comment',
      '',
      'GITHUB_TOKEN="abc123"',
      "GH_TOKEN='def456'",
      'PLAIN=unquoted',
      'export EXPORTED=yes',
      'WITH_HASH=value # trailing comment',
      'NO_EQUALS',
      '=NOKEY'
    ].join('\n'));
    assert.equal(map.GITHUB_TOKEN, 'abc123');
    assert.equal(map.GH_TOKEN, 'def456');
    assert.equal(map.PLAIN, 'unquoted');
    assert.equal(map.EXPORTED, 'yes');
    assert.equal(map.WITH_HASH, 'value');
    assert.ok(!('NO_EQUALS' in map));
    assert.ok(!('' in map));
  });

  it('yields nothing for junk', () => {
    assert.deepEqual(parseDotEnv('random text\nmore'), {});
    assert.deepEqual(parseDotEnv(null), {});
  });
});

describe('github token resolution', () => {
  const saved = {};
  beforeEach(() => {
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads GITHUB_TOKEN then GH_TOKEN from the environment', () => {
    process.env.GITHUB_TOKEN = 'from-env';
    assert.equal(readGitHubToken(process.env, '/no/such/.env'), 'from-env');
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'from-gh';
    assert.equal(readGitHubToken(process.env, '/no/such/.env'), 'from-gh');
  });

  it('falls back to a .env file the environment does not override', () => {
    const file = join(tmpDir(), '.env');
    writeFileSync(file, 'GITHUB_TOKEN=file-token\n', 'utf8');
    assert.equal(readGitHubToken({}, file), 'file-token');
    // The environment wins over the file, so an exported token is never
    // shadowed by a stale one on disk.
    assert.equal(readGitHubToken({ GITHUB_TOKEN: 'env-wins' }, file), 'env-wins');
  });

  it('is absent when nowhere set', () => {
    assert.equal(readGitHubToken({}, join(tmpDir(), 'absent.env')), null);
  });
});

/* ------------------------------------------------------------- records/merge */

describe('github repo records', () => {
  it('normalizes a GitHub API repo', () => {
    const base = tmpDir();
    const record = repoRecord(
      {
        id: 42,
        name: 'alpha',
        fullName: 'me/alpha',
        private: true,
        cloneUrl: 'git@github.com:me/alpha.git',
        htmlUrl: 'https://github.com/me/alpha',
        defaultBranch: 'main',
        updatedAt: '2026-09-01T00:00:00Z'
      },
      base
    );
    assert.equal(record.id, '42');
    assert.equal(record.fullName, 'me/alpha');
    assert.equal(record.private, true);
    assert.equal(record.defaultBranch, 'main');
    // The guess falls back to the base dir when no candidate exists, and
    // `cloned` is recomputed from disk rather than trusted.
    assert.equal(record.localPath, join(base, 'alpha'));
    assert.equal(record.cloned, false);
  });

  it('marks a repo cloned when the guessed path exists', () => {
    const base = tmpDir();
    mkdirSync(join(base, 'alpha'));
    const record = repoRecord({ id: 1, name: 'alpha', fullName: 'me/alpha' }, base);
    assert.equal(record.cloned, true);
  });

  it('guesses a conventional clone location before the base dir', () => {
    // No machine is guaranteed to have this repo cloned anywhere, so the
    // assertion is about the fallback; the candidate list is the contract
    // that makes real machines hit their clone first.
    const base = tmpDir();
    const guessed = guessLocalPath('zstack-gh-no-such-repo-xyz', base);
    assert.equal(guessed, join(base, 'zstack-gh-no-such-repo-xyz'));
  });
});

describe('github store', () => {
  it('round-trips and recomputes cloned on read', () => {
    const base = tmpDir();
    mkdirSync(join(base, 'alpha'));
    const store = join(base, 'github.json');
    writeGitHubStore(store, {
      login: 'me',
      syncedAt: '2026-09-01T00:00:00Z',
      baseDir: base,
      repos: [
        repoRecord({ id: 1, name: 'alpha', fullName: 'me/alpha' }, base),
        repoRecord({ id: 2, name: 'beta', fullName: 'me/beta' }, base)
      ]
    });
    const read = readGitHubStore(store);
    assert.equal(read.login, 'me');
    assert.equal(read.repos.length, 2);
    assert.equal(read.repos[0].cloned, true);
    assert.equal(read.repos[1].cloned, false);
  });

  it('tolerates a corrupted file', () => {
    const store = join(tmpDir(), 'github.json');
    writeFileSync(store, '{not json', 'utf8');
    const read = readGitHubStore(store);
    assert.deepEqual(read.repos, []);
    assert.equal(read.corrupted, true);
  });
});

describe('github merge', () => {
  it('preserves an edited localPath whose directory still exists', () => {
    const base = tmpDir();
    const clone = join(base, 'elsewhere', 'alpha');
    mkdirSync(join(base, 'elsewhere', 'alpha'), { recursive: true });
    const existing = [repoRecord({ id: 1, name: 'alpha', fullName: 'me/alpha', localPath: clone }, base)];
    const fetched = [{ id: 1, name: 'alpha', fullName: 'me/alpha', updatedAt: '2026-09-02T00:00:00Z' }];
    const merged = mergeRepos(existing, fetched, base);
    assert.equal(merged[0].localPath, clone);
  });

  it('re-guesses a stored path that no longer exists', () => {
    const base = tmpDir();
    const existing = [
      repoRecord(
        { id: 1, name: 'alpha', fullName: 'me/alpha', localPath: join(base, 'gone') },
        base
      )
    ];
    const fetched = [{ id: 1, name: 'alpha', fullName: 'me/alpha' }];
    const merged = mergeRepos(existing, fetched, base);
    assert.equal(merged[0].localPath, join(base, 'alpha'));
  });

  it('adds new repos and refreshes the fields the API owns', () => {
    const base = tmpDir();
    const existing = [repoRecord({ id: 1, name: 'alpha', fullName: 'me/alpha' }, base)];
    const fetched = [
      { id: 1, name: 'alpha', fullName: 'me/alpha', updatedAt: 'later' },
      { id: 2, name: 'beta', fullName: 'me/beta', updatedAt: 'now' }
    ];
    const merged = mergeRepos(existing, fetched, base);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].updatedAt, 'later');
    assert.equal(merged[1].fullName, 'me/beta');
  });
});

describe('github fetch', () => {
  it('refuses to run without a token', async () => {
    await assert.rejects(() => fetchGitHubRepos({ token: null }), (err) => err.kind === 'github-no-token');
  });

  it('stops paginating on a short page', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const batch = page === 1
        ? [{ id: 1, name: 'alpha', full_name: 'me/alpha', owner: { login: 'me' }, updated_at: 't' }]
        : [];
      return { ok: true, status: 200, json: async () => batch };
    };
    const doc = await fetchGitHubRepos({ token: 'tok', fetchImpl });
    assert.equal(doc.login, 'me');
    assert.equal(doc.repos.length, 1);
    assert.equal(doc.repos[0].fullName, 'me/alpha');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('page=1'));
  });

  it('reports an unauthorized token as 401-shaped', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(
      () => fetchGitHubRepos({ token: 'bad', fetchImpl }),
      (err) => err.kind === 'github-unauthorized'
    );
  });
});

/* ------------------------------------------------------------------- server */

/**
 * A repo the tests own end to end: a temp base dir holds its clone, so the
 * guess, the store, and the project all point at directories this suite made.
 */
function fixtureRepo(name) {
  return {
    id: 1,
    name,
    full_name: `me/${name}`,
    private: false,
    clone_url: `git@github.com:me/${name}.git`,
    html_url: `https://github.com/me/${name}`,
    default_branch: 'main',
    updated_at: '2026-09-01T00:00:00Z',
    owner: { login: 'me' }
  };
}

function githubApiMock(repos) {
  return async (url) => {
    assert.ok(url.startsWith('https://api.github.com/user/repos'), 'calls the GitHub API');
    return { ok: true, status: 200, json: async () => repos };
  };
}

async function boot(options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'zstack-ghsrv-'));
  const githubStore = join(base, 'github.json');
  const baseDir = join(base, 'clones');
  mkdirSync(baseDir, { recursive: true });
  // The store is seeded with the temp base dir, so every guess lands in the
  // temp tree instead of probing the real home directory for clone candidates.
  writeGitHubStore(githubStore, { login: null, syncedAt: null, baseDir, repos: [] });
  const zstack = {
    listPlaybooks: () => [],
    listPrinciples: () => [],
    status: async () => ({ ok: true })
  };
  const started = await startServer({
    port: 0,
    zstack,
    historyPath: join(base, 'history.jsonl'),
    projectsPath: join(base, 'projects.json'),
    overridesPath: join(base, 'run-overrides.json'),
    githubPath: githubStore,
    githubFetch: options.githubFetch,
    ghExecFile: options.ghExecFile || ((_file, _args, _opts, cb) => cb(new Error('gh unavailable in hermetic tests'), ''))
  });
  return {
    ...started,
    baseDir,
    githubStore,
    projectsStore: join(base, 'projects.json'),
    api: (path, init) => fetch(`${started.url}api${path}`, init),
    close: () => new Promise((r) => started.server.close(r))
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((close) => close()));
});

async function bootTracked(options) {
  const s = await boot(options);
  servers.push(s.close);
  return s;
}

describe('github endpoints', () => {
  const savedToken = process.env.GITHUB_TOKEN;
  const savedGh = process.env.GH_TOKEN;
  const realCwd = process.cwd();
  after(() => {
    for (const [key, value] of [['GITHUB_TOKEN', savedToken], ['GH_TOKEN', savedGh]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(realCwd);
  });

  it('reads the catalogue without touching the network', async () => {
    const s = await bootTracked();
    const res = await s.api('/github');
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.repos, []);
    assert.equal(typeof doc.configured, 'boolean');
  });

  it('refuses a sync without a token', async () => {
    const s = await bootTracked();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // A real .env next to the server would satisfy the token check, so the
    // cwd moves somewhere the file cannot exist for the duration.
    process.chdir(tmpDir());
    try {
      const res = await s.api('/github/sync', { method: 'POST' });
      assert.equal(res.status, 400);
      const doc = await res.json();
      assert.match(doc.error, /GITHUB_TOKEN/);
    } finally {
      process.chdir(realCwd);
    }
  });

  it('uses an injected gh fallback without returning its token', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.chdir(tmpDir());
    let calls = 0;
    try {
      const s = await bootTracked({
        ghExecFile: (_file, _args, _opts, cb) => { calls++; cb(null, 'injected-gh-secret\n'); },
        githubFetch: async (_url, init) => {
          assert.equal(init.headers.authorization, 'Bearer injected-gh-secret');
          return { ok: true, status: 200, json: async () => [] };
        }
      });
      const catalogue = await (await s.api('/github')).json();
      assert.equal(catalogue.configured, true);
      assert.equal((await s.api('/github/sync', { method: 'POST' })).status, 200);
      assert.equal(calls, 1);
      assert.equal(JSON.stringify(catalogue).includes('injected-gh-secret'), false);
    } finally { process.chdir(realCwd); }
  });

  it('syncs repos, guesses clone paths, and creates a project per clone', async () => {
    const s = await bootTracked({ githubFetch: githubApiMock([fixtureRepo('zstack-gh-alpha-1')]) });
    // The clone directory the sync should discover.
    const cloneDir = join(s.baseDir, 'zstack-gh-alpha-1');
    mkdirSync(cloneDir);
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      const res = await s.api('/github/sync', { method: 'POST' });
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.ok, true);
      assert.equal(doc.login, 'me');
      assert.equal(doc.projectsCreated, 1);
      assert.equal(doc.repos.length, 1);
      assert.equal(doc.repos[0].localPath, cloneDir);
      assert.equal(doc.repos[0].cloned, true);
      assert.ok(doc.repos[0].projectId);

      // The project exists and points at the clone.
      const { projects } = readProjects(s.projectsStore);
      const project = projects.find((p) => p.name === 'zstack-gh-alpha-1');
      assert.ok(project, 'sync created a project for the cloned repo');
      assert.equal(project.dir, cloneDir);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('keeps an uncloned repo but creates no project for it', async () => {
    const name = 'zstack-gh-never-cloned-2';
    const s = await bootTracked({ githubFetch: githubApiMock([fixtureRepo(name)]) });
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      const res = await s.api('/github/sync', { method: 'POST' });
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.repos[0].cloned, false);
      assert.equal(doc.repos[0].projectId, null);
      assert.equal(doc.projectsCreated, 0);
      const { projects } = readProjects(s.projectsStore);
      assert.equal(projects.filter((p) => p.name === name).length, 0);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('repoints a repo at an existing directory and relinks its project', async () => {
    const name = 'zstack-gh-repoint-3';
    const s = await bootTracked({ githubFetch: githubApiMock([fixtureRepo(name)]) });
    const firstClone = join(s.baseDir, name);
    mkdirSync(firstClone);
    const secondClone = join(s.baseDir, 'elsewhere', name);
    mkdirSync(secondClone, { recursive: true });
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      await s.api('/github/sync', { method: 'POST' });
      const res = await s.api('/github/repos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: `me/${name}`, localPath: secondClone })
      });
      assert.equal(res.status, 200);
      const doc = await res.json();
      assert.equal(doc.repo.localPath, secondClone);
      assert.equal(doc.repo.cloned, true);

      // A re-sync keeps the edited path: the merge is what preserves it.
      const resync = await s.api('/github/sync', { method: 'POST' });
      const redoc = await resync.json();
      assert.equal(redoc.repos[0].localPath, secondClone);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('rejects a repoint at a missing directory or an unknown repo', async () => {
    const name = 'zstack-gh-reject-4';
    const s = await bootTracked({ githubFetch: githubApiMock([fixtureRepo(name)]) });
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      await s.api('/github/sync', { method: 'POST' });
      const missing = await s.api('/github/repos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: `me/${name}`, localPath: join(s.baseDir, 'not-there') })
      });
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /does not exist/);

      const unknown = await s.api('/github/repos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: 'me/no-such', localPath: s.baseDir })
      });
      assert.equal(unknown.status, 404);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe('pull request helpers', () => {
  it('parses GitHub remote URLs across HTTPS and SSH formats', () => {
    assert.deepEqual(parseGitHubRemote('https://github.com/octocat/Hello-World.git'), {
      owner: 'octocat',
      repo: 'Hello-World',
      fullName: 'octocat/Hello-World'
    });
    assert.deepEqual(parseGitHubRemote('https://github.com/octocat/Hello-World'), {
      owner: 'octocat',
      repo: 'Hello-World',
      fullName: 'octocat/Hello-World'
    });
    assert.deepEqual(parseGitHubRemote('git@github.com:octocat/Hello-World.git'), {
      owner: 'octocat',
      repo: 'Hello-World',
      fullName: 'octocat/Hello-World'
    });
    assert.deepEqual(parseGitHubRemote('ssh://git@github.com/octocat/Hello-World.git'), {
      owner: 'octocat',
      repo: 'Hello-World',
      fullName: 'octocat/Hello-World'
    });
    assert.equal(parseGitHubRemote('https://gitlab.com/octocat/Hello-World.git'), null);
    assert.equal(parseGitHubRemote(''), null);
    assert.equal(parseGitHubRemote(null), null);
  });

  it('createPullRequest uses gh CLI when available', async () => {
    const dir = tmpDir();
    const fakeExec = (cmd, args, opts, cb) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        cb(null, 'https://github.com/octocat/Hello-World/pull/42\n', '');
      } else {
        cb(new Error('unexpected command'));
      }
    };
    const res = await createPullRequest({
      dir,
      title: 'feat: add toggle',
      body: 'PR body',
      head: 'feature-branch',
      execFileImpl: fakeExec
    });
    assert.equal(res.ok, true);
    assert.equal(res.url, 'https://github.com/octocat/Hello-World/pull/42');
    assert.equal(res.method, 'gh');
  });

  it('createPullRequest falls back to GitHub REST API when gh fails', async () => {
    const dir = tmpDir();
    const fakeExec = (cmd, args, opts, cb) => {
      if (cmd === 'gh') {
        cb(new Error('gh not logged in'), '', 'not logged in');
      } else if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        cb(null, 'https://github.com/my-org/my-repo.git\n', '');
      } else if (cmd === 'git' && args[0] === 'rev-parse') {
        cb(null, 'sha123\n', '');
      } else {
        cb(new Error('unexpected'));
      }
    };
    let calledUrl = null;
    let calledBody = null;
    const fakeFetch = async (url, options) => {
      calledUrl = url;
      calledBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          html_url: 'https://github.com/my-org/my-repo/pull/99',
          number: 99
        })
      };
    };

    const res = await createPullRequest({
      dir,
      title: 'feat: new feature',
      body: 'summary',
      head: 'zstack/feature-1',
      token: 'token-xyz',
      execFileImpl: fakeExec,
      fetchImpl: fakeFetch
    });

    assert.equal(res.ok, true);
    assert.equal(res.url, 'https://github.com/my-org/my-repo/pull/99');
    assert.equal(res.number, 99);
    assert.equal(res.method, 'api');
    assert.equal(calledUrl, 'https://api.github.com/repos/my-org/my-repo/pulls');
    assert.equal(calledBody.head, 'zstack/feature-1');
  });
});

