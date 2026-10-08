import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKey,
  rotateKey,
  updateKey,
  deleteKey,
  findKey,
  readKeys,
  readKeyRecords,
  verifyKeySecret,
  recordKeyUse,
  resetPendingKeyUsage,
  validateKeyInput,
  hashKeySecret,
  generateKeySecret,
  looksLikeKey,
  publicKey,
  secureEquals,
  KEY_PREFIX,
  KEY_NAME_MAX
} from '../src/keys.mjs';
import { startServer } from '../src/serve.mjs';

const CLI = fileURLToPath(new URL('../bin/zstack.mjs', import.meta.url));

const tempDirs = [];
function tmpDir(prefix = 'zstack-keys-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tmpStore() {
  return join(tmpDir(), 'keys.json');
}

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function stubZStack() {
  return {
    baseUrl: 'http://127.0.0.1:3939',
    async status() {
      return { ok: true, baseUrl: 'http://127.0.0.1:3939', message: 'connected', activeProviders: ['opencode'], mode: 'catalog', lane: 'auto' };
    },
    listPlaybooks: () => [],
    listPrinciples: () => [],
    getBudget: () => ({ tier: 'med-high', source: 'catalog', lane: 'auto' }),
    async agent() { throw new Error('the keys tests must not start a run'); }
  };
}

/**
 * A server whose key store is a temp file, so a test never touches the real
 * `~/.zstack/keys.json`.
 */
async function boot(options = {}) {
  const dir = tmpDir('zstack-keys-srv-');
  const keysPath = options.keysPath ?? join(dir, 'keys.json');
  const started = await startServer({
    port: 0,
    zstack: stubZStack(),
    historyPath: join(dir, 'history.jsonl'),
    projectsPath: join(dir, 'projects.json'),
    overridesPath: join(dir, 'overrides.json'),
    chatsPath: join(dir, 'chats.json'),
    schedulesPath: join(dir, 'schedules.json'),
    budgetPath: join(dir, 'budget.json'),
    keysPath,
    enableScheduler: false,
    apiToken: options.apiToken,
    requireAuth: options.requireAuth
  });
  const call = (path, init = {}) => fetch(`${started.url}api${path}`, {
    ...init,
    headers: { ...(init.headers || {}) }
  });
  return {
    ...started,
    keysPath,
    call,
    json: (path, payload, method = 'POST', headers = {}) => call(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    }),
    close: () => new Promise((resolve) => started.server.close(resolve))
  };
}

function runCli(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('api key secrets', () => {
  it('mints secrets with the zstk- prefix and enough entropy to be unguessable', () => {
    const secrets = new Set();
    for (let i = 0; i < 200; i++) {
      const secret = generateKeySecret();
      assert.ok(secret.startsWith(KEY_PREFIX), secret);
      assert.ok(secret.length >= 40, `secret too short: ${secret}`);
      assert.match(secret.slice(KEY_PREFIX.length), /^[A-Za-z0-9_-]+$/);
      assert.ok(!secrets.has(secret), 'generated a duplicate secret');
      secrets.add(secret);
    }
  });

  it('recognises only well formed secrets', () => {
    assert.equal(looksLikeKey(generateKeySecret()), true);
    assert.equal(looksLikeKey(''), false);
    assert.equal(looksLikeKey(undefined), false);
    assert.equal(looksLikeKey('sk-somethingelse'), false);
    assert.equal(looksLikeKey(`${KEY_PREFIX}tooshort`), false);
  });

  it('compares secrets without matching on length alone', () => {
    assert.equal(secureEquals('a', 'a'), true);
    assert.equal(secureEquals('a', 'b'), false);
    assert.equal(secureEquals('a', 'aa'), false);
    assert.equal(secureEquals(null, 'a'), false);
  });
});

describe('api key store', () => {
  let store;
  beforeEach(() => {
    store = tmpStore();
    resetPendingKeyUsage();
  });

  it('creates a key whose secret is returned once and only stored as a digest', () => {
    const { key, secret } = createKey({ name: 'Workfolk prod', assignedTo: 'gateway-01' }, store);
    assert.ok(key.id.startsWith('k-'));
    assert.equal(key.name, 'Workfolk prod');
    assert.equal(key.assignedTo, 'gateway-01');
    assert.equal(key.active, true);
    assert.equal(key.rotations, 0);
    assert.equal(key.lastUsedAt, null);
    assert.equal(key.prefix, secret.slice(0, 12));

    const raw = readFileSync(store, 'utf8');
    assert.doesNotMatch(raw, new RegExp(secret), 'the secret itself must never be written');
    assert.match(raw, new RegExp(hashKeySecret(secret)));
    // The public projection is what the API and the page ever see.
    assert.equal('hash' in key, false);
    assert.equal(readKeys(store).keys[0].hash, undefined);
  });

  it('refuses a key with no name, and every other problem at once', () => {
    assert.throws(() => createKey({}, store), (err) => {
      assert.equal(err.kind, 'invalid-key');
      assert.ok(err.problems.some((p) => /needs a name/.test(p)));
      return true;
    });
    const problems = validateKeyInput(
      { name: 'x'.repeat(KEY_NAME_MAX + 1), assignedTo: 7, notes: 9, expiresInDays: -1 },
      []
    );
    assert.ok(problems.length >= 4, `expected every problem, got ${JSON.stringify(problems)}`);
  });

  it('refuses a duplicate name case-insensitively, on create and on rename', () => {
    createKey({ name: 'Site' }, store);
    assert.throws(() => createKey({ name: 'site' }, store), /already exists/);
    const second = createKey({ name: 'Other' }, store);
    assert.throws(() => updateKey(second.key.id, { name: 'SITE' }, store), /already exists/);
    // Keeping your own name is not a clash.
    assert.equal(updateKey(second.key.id, { name: 'Other' }, store).name, 'Other');
  });

  it('renames, reassigns, and clears an assignment', () => {
    const { key } = createKey({ name: 'A', assignedTo: 'server-1' }, store);
    const renamed = updateKey(key.id, { name: 'B', assignedTo: 'site.example.com' }, store);
    assert.equal(renamed.name, 'B');
    assert.equal(renamed.assignedTo, 'site.example.com');
    const cleared = updateKey(key.id, { assignedTo: '' }, store);
    assert.equal(cleared.assignedTo, null);
    const noted = updateKey(key.id, { notes: 'deployed to the edge box' }, store);
    assert.equal(noted.notes, 'deployed to the edge box');
  });

  it('resolves a key by id, name, or the visible prefix', () => {
    const { key, secret } = createKey({ name: 'Resolve me' }, store);
    assert.equal(findKey(key.id, store).id, key.id);
    assert.equal(findKey('resolve me', store).id, key.id);
    assert.equal(findKey(secret.slice(0, 12), store).id, key.id);
    assert.equal(findKey('nothing like this', store), null);
  });

  it('rotates the secret, keeps the identity, and kills the old secret immediately', () => {
    const { key, secret } = createKey({ name: 'Deployed', assignedTo: 'box-1' }, store);
    const rotated = rotateKey(key.id, store);
    assert.equal(rotated.key.id, key.id);
    assert.equal(rotated.key.name, 'Deployed');
    assert.equal(rotated.key.assignedTo, 'box-1');
    assert.equal(rotated.key.rotations, 1);
    assert.notEqual(rotated.secret, secret);
    assert.equal(verifyKeySecret(secret, store), null, 'the old secret must stop working');
    assert.equal(verifyKeySecret(rotated.secret, store).id, key.id);
    assert.equal(readKeys(store).keys.length, 1, 'rotation must not add a key');
  });

  it('deletes a key and reports an unknown reference rather than inventing one', () => {
    const { key, secret } = createKey({ name: 'Temporary' }, store);
    deleteKey(key.id, store);
    assert.equal(readKeys(store).keys.length, 0);
    assert.equal(verifyKeySecret(secret, store), null);
    assert.throws(() => deleteKey(key.id, store), (err) => err.kind === 'unknown-key');
    assert.throws(() => rotateKey('nobody', store), (err) => err.kind === 'unknown-key');
  });

  it('refuses an ambiguous reference instead of guessing', () => {
    createKey({ name: 'One' }, store);
    createKey({ name: 'Two' }, store);
    // Two records sharing a name is what the boundary refuses to create, so the
    // store is edited directly: an older file, or a hand edit, must resolve to a
    // refusal rather than to "whichever one came first".
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    raw.keys[1].name = 'One';
    writeFileSync(store, JSON.stringify(raw, null, 2));
    assert.throws(() => rotateKey('One', store), (err) => err.kind === 'ambiguous-key');
    assert.throws(() => updateKey('One', { name: 'Three' }, store), (err) => err.kind === 'ambiguous-key');
    // An id is still unambiguous, which is what the error tells the caller to use.
    assert.equal(rotateKey(raw.keys[0].id, store).key.id, raw.keys[0].id);
  });

  it('authenticates an unexpired key and refuses an expired one', () => {
    const { key, secret } = createKey({ name: 'Short lived', expiresInDays: 1 }, store);
    assert.equal(verifyKeySecret(secret, store).id, key.id);
    assert.equal(readKeys(store).keys[0].active, true);
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    assert.equal(verifyKeySecret(secret, store, later), null);
    assert.equal(readKeys(store, later).keys[0].expired, true);
    assert.equal(readKeys(store, later).keys[0].active, false);
  });

  it('sets, extends, and clears an expiry without a rename touching it', () => {
    const { key } = createKey({ name: 'Expiring', expiresInDays: 5 }, store);
    const first = readKeys(store).keys[0].expiresAt;
    assert.ok(first);

    // A rename says nothing about expiry, so it must leave it alone.
    assert.equal(updateKey(key.id, { name: 'Expiring still' }, store).expiresAt, first);

    const extended = updateKey(key.id, { expiresInDays: 30 }, store);
    assert.ok(Date.parse(extended.expiresAt) > Date.parse(first));

    // An explicitly empty value is what removes it.
    assert.equal(updateKey(key.id, { expiresAt: '' }, store).expiresAt, null);
    assert.equal(updateKey(key.id, { expiresInDays: 7 }, store).expiresAt !== null, true);
    assert.equal(updateKey(key.id, { expiresInDays: null }, store).expiresAt, null);

    // Junk is refused rather than quietly clearing the expiry.
    assert.throws(() => updateKey(key.id, { expiresInDays: 'soon' }, store), (err) => err.kind === 'invalid-key');
    assert.throws(() => updateKey(key.id, { expiresInDays: -3 }, store), /positive number of days/);
    assert.throws(() => updateKey(key.id, { expiresAt: 'the end of time' }, store), /must be a date/);
  });

  it('gives a rotated key a new life when the caller asks for one', () => {
    const { key } = createKey({ name: 'Renewed' }, store);
    assert.equal(readKeys(store).keys[0].expiresAt, null);
    assert.ok(rotateKey(key.id, store, { expiresInDays: 10 }).key.expiresAt);
    const second = createKey({ name: 'Already expiring', expiresInDays: 1 }, store);
    // Without an instruction, rotation keeps the existing window.
    assert.equal(rotateKey(second.key.id, store).key.expiresAt, second.key.expiresAt);
    assert.throws(() => rotateKey(second.key.id, store, { expiresInDays: 'never' }), (err) => err.kind === 'invalid-key');
  });

  it('fails closed on a corrupted store instead of accepting anything', () => {
    const { secret } = createKey({ name: 'Real' }, store);
    writeFileSync(store, '{ this is not json', 'utf8');
    const read = readKeys(store);
    assert.equal(read.corrupted, true);
    assert.deepEqual(read.keys, []);
    assert.equal(verifyKeySecret(secret, store), null);
    assert.throws(() => createKey({ name: 'New' }, store), (err) => err.kind === 'corrupted-store');
    assert.throws(() => rotateKey('Real', store), (err) => err.kind === 'corrupted-store');
  });

  it('drops a record that has no digest rather than treating it as open', () => {
    const { secret } = createKey({ name: 'Real' }, store);
    writeFileSync(store, JSON.stringify({ version: 1, keys: [{ id: 'k-x', name: 'Hand edited' }] }, null, 2));
    assert.equal(readKeyRecords(store).records.length, 0);
    assert.equal(verifyKeySecret(secret, store), null);
  });

  it('treats a missing store as empty, not as an error', () => {
    const read = readKeys(join(tmpDir(), 'never-written.json'));
    assert.equal(read.corrupted, false);
    assert.deepEqual(read.keys, []);
  });
});

describe('api key usage recording', () => {
  it('writes the first use, then batches uses inside the interval', () => {
    const store = tmpStore();
    resetPendingKeyUsage();
    const { key } = createKey({ name: 'Poller' }, store);
    const record = readKeyRecords(store).records[0];

    // The first use is due immediately: a key that was never used has no
    // timestamp to throttle against.
    assert.equal(recordKeyUse(record, store, { from: '10.0.0.9', now: Date.now() }), true);
    let stored = readKeyRecords(store).records[0];
    assert.equal(stored.requestCount, 1);
    assert.equal(stored.lastUsedFrom, '10.0.0.9');
    assert.ok(stored.lastUsedAt);

    // Uses inside the window are counted in memory, not written.
    const soon = Date.now() + 1000;
    assert.equal(recordKeyUse(record, store, { now: soon }), false);
    assert.equal(recordKeyUse(record, store, { now: soon + 1000 }), false);
    assert.equal(readKeyRecords(store).records[0].requestCount, 1, 'batched uses must not be written yet');

    // Past the window the batched count lands in one write.
    assert.equal(recordKeyUse(record, store, { now: Date.now() + 120000 }), true);
    stored = readKeyRecords(store).records[0];
    assert.equal(stored.requestCount, 4);
    assert.equal(findKey(key.id, store).requestCount, 4);
  });

  it('does not resurrect a key that was deleted mid-flight', () => {
    const store = tmpStore();
    resetPendingKeyUsage();
    const { key } = createKey({ name: 'Gone' }, store);
    const record = readKeyRecords(store).records[0];
    deleteKey(key.id, store);
    recordKeyUse(record, store, { now: Date.now() });
    assert.equal(readKeys(store).keys.length, 0);
  });
});

describe('api key HTTP surface', () => {
  it('mints, lists, renames, rotates, and deletes over HTTP without ever re-showing a secret', async () => {
    const s = await boot();
    try {
      const created = await s.json('/keys', { name: 'Workfolk prod', assignedTo: 'gateway-01', notes: 'dispatch' });
      assert.equal(created.status, 201);
      const body = await created.json();
      assert.ok(body.secret.startsWith(KEY_PREFIX));
      assert.equal(body.key.prefix, body.secret.slice(0, 12));
      assert.equal('hash' in body.key, false);

      const list = await (await s.call('/keys')).json();
      assert.equal(list.ok, true);
      assert.equal(list.keys.length, 1);
      assert.equal(list.keys[0].name, 'Workfolk prod');
      assert.equal(list.keys[0].assignedTo, 'gateway-01');
      assert.doesNotMatch(JSON.stringify(list), new RegExp(body.secret), 'the listing must not carry the secret');

      const renamed = await (await s.json(`/keys/${body.key.id}`, { name: 'Renamed', assignedTo: 'gateway-02' }, 'PATCH')).json();
      assert.equal(renamed.key.name, 'Renamed');
      assert.equal(renamed.key.assignedTo, 'gateway-02');

      const rotated = await (await s.json(`/keys/${body.key.id}/rotate`, {}, 'POST')).json();
      assert.notEqual(rotated.secret, body.secret);
      assert.equal(rotated.key.id, body.key.id);
      assert.equal(rotated.key.rotations, 1);

      const deleted = await (await s.call(`/keys/${body.key.id}`, { method: 'DELETE' })).json();
      assert.equal(deleted.deleted, body.key.id);
      assert.equal((await (await s.call('/keys')).json()).keys.length, 0);
    } finally {
      await s.close();
    }
  });

  it('reports every validation problem at once with 400, and 404 for a reference that names nothing', async () => {
    const s = await boot();
    try {
      const bad = await s.json('/keys', { name: '' });
      assert.equal(bad.status, 400);
      const doc = await bad.json();
      assert.equal(doc.ok, false);
      assert.ok(doc.problems.length >= 1);
      assert.ok(doc.detail);

      assert.equal((await s.call('/keys/k-nope', { method: 'DELETE' })).status, 404);
      assert.equal((await s.json('/keys/k-nope/rotate', {}, 'POST')).status, 404);
      assert.equal((await s.call('/keys/k-nope')).status, 404);
      assert.equal((await s.call('/keys', { method: 'PUT' })).status, 405);
    } finally {
      await s.close();
    }
  });

  it('authenticates a stored key wherever a credential is required, and mints nothing without one', async () => {
    const s = await boot({ requireAuth: true });
    try {
      // No credential at all: refused, including the mint endpoint. A server
      // that required credentials but handed out new ones on request would
      // require nothing at all; the bootstrap is the CLI, which owns the file.
      assert.equal((await s.call('/health')).status, 401);
      assert.equal((await s.json('/keys', { name: 'Unauthenticated mint' })).status, 401);

      // The shell is still readable, because a page that cannot load cannot
      // offer anywhere to enter a key.
      const shell = await fetch(s.url);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get('content-type'), /text\/html/);

      const { secret: key } = createKey({ name: 'CI' }, s.keysPath);

      for (const headers of [
        { authorization: `Bearer ${key}` },
        { 'x-api-token': key },
        { authorization: key }
      ]) {
        const res = await s.call('/health', { headers });
        assert.equal(res.status, 200, `expected ${JSON.stringify(headers)} to authenticate`);
      }
      assert.equal((await s.call('/health', { headers: { authorization: 'Bearer zstk-nope' } })).status, 401);
      assert.equal((await s.call(`/health?token=${encodeURIComponent(key)}`)).status, 200);

      // The authenticated call is recorded against the key, and a key may manage
      // keys: there are no per-key permissions, so a valid one is a whole-API
      // credential.
      const authorized = { authorization: `Bearer ${key}` };
      const listed = await (await s.call('/keys', { headers: authorized })).json();
      assert.equal(listed.keys[0].requestCount, 1);
      assert.ok(listed.keys[0].lastUsedAt);
      assert.equal(listed.requireAuth, true);

      const created = await s.json('/keys', { name: 'Second', assignedTo: 'box-2' }, 'POST', authorized);
      assert.equal(created.status, 201);
      assert.equal((await created.json()).key.assignedTo, 'box-2');
    } finally {
      await s.close();
    }
  });

  it('keeps the shared token working beside stored keys, and reports when neither is needed', async () => {
    const s = await boot({ apiToken: 'shared-secret-123' });
    try {
      assert.equal((await s.call('/health')).status, 401);
      const created = await (await s.json('/keys', { name: 'Keyed' }, 'POST', { authorization: 'Bearer shared-secret-123' })).json();
      assert.ok(created.secret);

      assert.equal((await s.call('/health', { headers: { authorization: 'Bearer shared-secret-123' } })).status, 200);
      assert.equal((await s.call('/health', { headers: { authorization: `Bearer ${created.secret}` } })).status, 200);
      assert.equal((await s.call('/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);

      const listed = await (await s.call('/keys', { headers: { authorization: 'Bearer shared-secret-123' } })).json();
      assert.equal(listed.tokenConfigured, true);
      assert.equal(listed.requireAuth, false);
    } finally {
      await s.close();
    }
  });

  it('leaves the API open on loopback until credentials are asked for', async () => {
    const s = await boot();
    try {
      const listed = await (await s.call('/keys')).json();
      assert.equal(listed.ok, true);
      assert.equal(listed.requireAuth, false);
      assert.equal(listed.tokenConfigured, false);
      assert.equal(listed.corrupted, undefined);
      assert.ok(listed.path.endsWith('keys.json'));
    } finally {
      await s.close();
    }
  });

  it('records the use of a key presented to a server that does not require one', async () => {
    // The common local mode asks for nothing, so a key that is presented anyway
    // is still the only evidence the Keys page has that it is in use. Reporting
    // "never used" for it would be the lie that gets a live key deleted.
    const s = await boot();
    try {
      const { secret } = createKey({ name: 'Used somewhere' }, s.keysPath);
      const res = await s.call('/health', { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(res.status, 200);

      const listed = await (await s.call('/keys')).json();
      assert.equal(listed.keys[0].requestCount, 1);
      assert.ok(listed.keys[0].lastUsedAt);
      assert.ok(listed.keys[0].lastUsedFrom);

      // A credential the store does not know is ignored rather than refused,
      // because a stale key in a browser must not brick a server that asks for
      // nothing.
      const stale = await s.call('/health', { headers: { authorization: 'Bearer zstk-stale' } });
      assert.equal(stale.status, 200);
    } finally {
      await s.close();
    }
  });
});

describe('api key CLI', () => {
  it('mints, lists, shows, rotates, reassigns, and deletes against a chosen store', () => {
    const store = tmpStore();
    const env = { ZSTACK_KEYS_PATH: store };

    const created = runCli(['keys', 'new', 'Deploy key', '--assign', 'box-1', '--notes', 'edge'], env);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /zstk-/);
    const secret = created.stdout.match(/zstk-[A-Za-z0-9_-]+/)[0];

    const listed = runCli(['keys', 'list', '--json'], env);
    assert.equal(listed.code, 0);
    const listDoc = JSON.parse(listed.stdout);
    assert.equal(listDoc.count, 1);
    assert.equal(listDoc.keys[0].name, 'Deploy key');
    assert.equal(listDoc.keys[0].assignedTo, 'box-1');
    assert.equal(listDoc.keys[0].active, true);
    assert.doesNotMatch(listed.stdout, new RegExp(secret));

    const shown = JSON.parse(runCli(['keys', 'show', 'Deploy key', '--json'], env).stdout);
    assert.equal(shown.key.notes, 'edge');

    const verified = runCli(['keys', 'verify', secret], env);
    assert.equal(verified.code, 0);
    assert.match(verified.stdout, /Valid/);
    assert.equal(runCli(['keys', 'verify', 'zstk-nope'], env).code, 1);

    const rotated = runCli(['keys', 'rotate', listDoc.keys[0].id, '--json'], env);
    assert.equal(rotated.code, 0);
    const rotatedDoc = JSON.parse(rotated.stdout);
    assert.equal(rotatedDoc.key.rotations, 1);
    assert.notEqual(rotatedDoc.secret, secret);
    assert.equal(runCli(['keys', 'verify', secret], env).code, 1, 'the old secret must fail after rotation');

    const assigned = JSON.parse(runCli(['keys', 'assign', 'Deploy key', '--assign', 'box-2', '--json'], env).stdout);
    assert.equal(assigned.key.assignedTo, 'box-2');

    assert.equal(runCli(['keys', 'new', 'Deploy key'], env).code, 2, 'a duplicate name is a usage error');

    const deleted = runCli(['keys', 'delete', 'Deploy key', '--yes', '--json'], env);
    assert.equal(deleted.code, 0);
    assert.equal(JSON.parse(deleted.stdout).deleted, listDoc.keys[0].id);
    assert.equal(JSON.parse(runCli(['keys', 'list', '--json'], env).stdout).count, 0);
  });

  it('prints a readable list with the assignment and the last use', () => {
    const store = tmpStore();
    const env = { ZSTACK_KEYS_PATH: store };
    runCli(['keys', 'new', 'Site key', '--assign', 'site.example.com'], env);
    const listed = runCli(['keys', 'list'], env);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /Site key/);
    assert.match(listed.stdout, /site\.example\.com/);
    assert.match(listed.stdout, /never used/);
    assert.match(listed.stdout, /secret is shown once/);
  });

  it('requires a name and a reference for the destructive and read subcommands', () => {
    const env = { ZSTACK_KEYS_PATH: tmpStore() };
    assert.equal(runCli(['keys', 'new'], env).code, 2);
    assert.match(runCli(['keys', 'new'], env).stderr, /needs a name/);
    assert.equal(runCli(['keys', 'rotate'], env).code, 2);
    assert.equal(runCli(['keys', 'delete'], env).code, 2);
    assert.equal(runCli(['keys', 'show', 'missing'], env).code, 1);
    assert.equal(runCli(['keys', 'nonsense'], env).code, 2);
    assert.equal(runCli(['keys', 'new', 'X', '--expires', 'soon'], env).code, 2);
  });

  it('holds an expired key out of the list of working credentials', () => {
    const store = tmpStore();
    const env = { ZSTACK_KEYS_PATH: store };
    const created = JSON.parse(runCli(['keys', 'new', 'Short', '--expires', '1', '--json'], env).stdout);
    const secret = created.secret;
    assert.ok(created.key.expiresAt);
    // Reach past the key's own expiry rather than waiting a day for it.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const raw = JSON.parse(readFileSync(store, 'utf8'));
    raw.keys[0].expiresAt = yesterday;
    writeFileSync(store, JSON.stringify(raw, null, 2));
    assert.equal(runCli(['keys', 'verify', secret], env).code, 1);
    const listed = JSON.parse(runCli(['keys', 'list', '--json'], env).stdout);
    assert.equal(listed.keys[0].expired, true);
    assert.equal(listed.keys[0].active, false);
    assert.equal(publicKey(raw.keys[0], Date.now()).expired, true);
  });
});
