/**
 * API keys: the named, rotatable credentials the HTTP API accepts.
 *
 * Authentication used to be one shared secret in `ZSTACK_API_TOKEN`, which is
 * fine for a single caller and useless the moment there are three: the token
 * cannot be named, cannot be revoked without breaking every caller at once, and
 * cannot be rotated without a coordinated restart. A key is the same idea with
 * an identity attached — a name, somewhere it is deployed, when it was issued,
 * when it was last used — so the operator can answer "what is this credential
 * for" and "which one do I kill" without guessing.
 *
 * Only a SHA-256 digest of each secret is stored. The secret itself is returned
 * once, at creation or rotation, and is unrecoverable afterwards: this file
 * lives in a home directory that gets synced, backed up, and occasionally
 * committed by accident, and a credential store that survives being leaked is
 * not a credential store. A stored prefix (`zstk-Ab3xY9Zk`) is what the list
 * shows, which is enough to tell two keys apart and useless to an attacker.
 *
 * Storage is a JSON file beside projects and chats, written atomically by
 * rename, for the same reason: a process killed mid-write must leave the
 * previous file rather than half of a new one. A corrupted file reads as no
 * keys at all, which fails closed — every credential stops working rather than
 * every credential being accepted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Every secret starts with this, so one is recognisable at a glance. */
export const KEY_PREFIX = 'zstk-';

/** Entropy per secret: 32 bytes rendered as 43 URL-safe characters. */
export const KEY_SECRET_BYTES = 32;

/** How much of a secret is kept in the clear for display and reference. */
export const KEY_DISPLAY_CHARS = 12;

/** Field limits, enforced at the boundary so a form can report them together. */
export const KEY_NAME_MAX = 60;
export const KEY_ASSIGNMENT_MAX = 120;
export const KEY_NOTES_MAX = 240;

/**
 * How often usage is persisted for a key.
 *
 * A key that is used by a polling integration would otherwise rewrite the store
 * on every request. Uses inside the window are counted in memory and written on
 * the first request after it elapses, so the file sees at most one write per
 * key per interval and `lastUsedAt` is never more than that stale.
 */
export const KEY_USAGE_WRITE_INTERVAL_MS = 60000;

/** Human labels for the numbers the caller passes as days. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function keysPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_KEYS_PATH ||
    join(homedir(), '.zstack', 'keys.json')
  );
}

/** A short id for a key. Stable across rotation: the secret changes, not the id. */
export function newKeyId() {
  return `k-${randomBytes(6).toString('hex')}`;
}

/** A fresh secret: `zstk-` plus 32 bytes of base64url. */
export function generateKeySecret() {
  return KEY_PREFIX + randomBytes(KEY_SECRET_BYTES).toString('base64url');
}

/**
 * Whether a string is even shaped like a key.
 *
 * Checked before hashing so an obviously wrong credential (an empty header, a
 * bare `Bearer`, a stray token from another service) costs nothing and cannot be
 * confused with a real one.
 */
export function looksLikeKey(secret) {
  if (typeof secret !== 'string') return false;
  if (!secret.startsWith(KEY_PREFIX)) return false;
  return secret.length === KEY_PREFIX.length + Math.ceil((KEY_SECRET_BYTES * 4) / 3);
}

/** The digest stored for a secret. Hex, so the file stays readable JSON. */
export function hashKeySecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/**
 * Compare two secrets without leaking where they diverge.
 *
 * Both sides are hashed first, so the comparison is over fixed-length buffers
 * and a short guess cannot be distinguished from a long one by timing, which is
 * what a naive `===` on strings gives away.
 */
export function secureEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest()
  );
}

/** The visible part of a secret: enough to identify, not enough to use. */
export function keyDisplayPrefix(secret) {
  return String(secret).slice(0, KEY_DISPLAY_CHARS);
}

function normaliseText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

function normaliseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A stored key record, with its digest. Never leaves this module as-is. */
function normaliseRecord(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || item.id === '') return null;
  if (typeof item.hash !== 'string' || item.hash === '') return null;
  const prefix = typeof item.prefix === 'string' && item.prefix !== ''
    ? item.prefix
    : null;
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : item.id,
    prefix,
    hash: item.hash,
    assignedTo: normaliseText(item.assignedTo, KEY_ASSIGNMENT_MAX),
    notes: normaliseText(item.notes, KEY_NOTES_MAX),
    createdAt: normaliseDate(item.createdAt) || new Date(0).toISOString(),
    updatedAt: normaliseDate(item.updatedAt),
    lastRotatedAt: normaliseDate(item.lastRotatedAt),
    rotations: Number.isInteger(item.rotations) && item.rotations > 0 ? item.rotations : 0,
    expiresAt: normaliseDate(item.expiresAt),
    lastUsedAt: normaliseDate(item.lastUsedAt),
    lastUsedFrom: normaliseText(item.lastUsedFrom, 60),
    requestCount: Number.isInteger(item.requestCount) && item.requestCount > 0 ? item.requestCount : 0
  };
}

/**
 * The record as the API and the page see it: no digest, ever.
 *
 * `expired` is computed on read rather than stored, because a stored boolean
 * would be wrong the moment the clock passed it.
 */
export function publicKey(record, now = Date.now()) {
  if (!record) return null;
  const expiresAt = record.expiresAt;
  const expired = expiresAt ? Date.parse(expiresAt) <= now : false;
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    assignedTo: record.assignedTo,
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    issuedAt: record.lastRotatedAt || record.createdAt,
    lastRotatedAt: record.lastRotatedAt,
    rotations: record.rotations,
    expiresAt,
    expired,
    // `active` is the one bit every caller needs: a key that authenticates.
    active: !expired,
    lastUsedAt: record.lastUsedAt,
    lastUsedFrom: record.lastUsedFrom,
    requestCount: record.requestCount
  };
}

/**
 * Read the whole store, digests included.
 *
 * A missing file is an empty store, not an error: a machine that has never made
 * a key is the normal first run. A corrupted file is reported as `corrupted`
 * with no keys, so every caller fails closed instead of authenticating anyone.
 */
export function readKeyRecords(pathOverride) {
  const file = keysPath(pathOverride);
  if (!existsSync(file)) return { records: [], corrupted: false, path: file };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { records: [], corrupted: true, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { records: [], corrupted: true, path: file };
  }
  const list = Array.isArray(parsed) ? parsed : parsed.keys;
  if (!Array.isArray(list)) return { records: [], corrupted: true, path: file };
  const records = [];
  for (const item of list) {
    const record = normaliseRecord(item);
    if (record) records.push(record);
  }
  return { records, corrupted: false, path: file };
}

/** The store without digests, for the API and the page. */
export function readKeys(pathOverride, now = Date.now()) {
  const { records, corrupted, path } = readKeyRecords(pathOverride);
  return {
    keys: records.map((record) => publicKey(record, now)),
    corrupted,
    path
  };
}

function writeStore(file, records) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, keys: records }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/**
 * Problems with an expiry instruction, in one place.
 *
 * Shared by create, update, and rotate so a junk value is refused wherever it
 * arrives. Without this, `expiresInDays: 'soon'` falls through the arithmetic to
 * `null` and silently clears an expiry, which is the opposite of what a caller
 * asking for an expiry meant.
 */
function expiryProblems(input = {}) {
  const problems = [];
  if (input.expiresInDays !== undefined) {
    // An explicitly empty value clears the expiry.
    const empty = input.expiresInDays === null || input.expiresInDays === '';
    if (!empty) {
      const days = Number(input.expiresInDays);
      if (!Number.isFinite(days) || days <= 0) {
        problems.push('Expiry must be a positive number of days, or empty for no expiry.');
      } else if (days > 3650) {
        problems.push('Expiry is at most 3650 days.');
      }
    }
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    const at = typeof input.expiresAt === 'number' ? input.expiresAt : Date.parse(String(input.expiresAt));
    if (Number.isNaN(at)) problems.push('Expiry must be a date, or empty for no expiry.');
  }
  return problems;
}

/** Whether the caller explicitly asked for no expiry. */
function clearsExpiry(input = {}) {
  const empty = (value) => value === null || value === '';
  return empty(input.expiresAt) || empty(input.expiresInDays);
}

/**
 * Validate a key's metadata at the boundary.
 *
 * Every problem is returned rather than the first, so a form can report them in
 * one response. `existing` is the current store and `selfId` the record being
 * edited, so a rename does not clash with itself.
 */
export function validateKeyInput(input = {}, existing = [], selfId = null) {
  const problems = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.push('A key needs a name, so it can be recognised later.');
  else if (name.length > KEY_NAME_MAX) problems.push(`A key name is at most ${KEY_NAME_MAX} characters.`);
  else if (existing.some((k) => k.id !== selfId && k.name.toLowerCase() === name.toLowerCase())) {
    problems.push(`A key named "${name}" already exists.`);
  }

  if (input.assignedTo !== undefined && input.assignedTo !== null) {
    if (typeof input.assignedTo !== 'string') problems.push('An assignment must be text.');
    else if (input.assignedTo.trim().length > KEY_ASSIGNMENT_MAX) {
      problems.push(`An assignment is at most ${KEY_ASSIGNMENT_MAX} characters.`);
    }
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string') problems.push('Notes must be text.');
    else if (input.notes.trim().length > KEY_NOTES_MAX) {
      problems.push(`Notes are at most ${KEY_NOTES_MAX} characters.`);
    }
  }
  problems.push(...expiryProblems(input));
  return problems;
}

function expiryFrom(input) {
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    const at = typeof input.expiresAt === 'number' ? input.expiresAt : Date.parse(String(input.expiresAt));
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const days = Number(input.expiresInDays);
  if (Number.isFinite(days) && days > 0) {
    return new Date(Date.now() + days * DAY_MS).toISOString();
  }
  return null;
}

function invalid(problems) {
  const err = new Error(problems.join(' '));
  err.kind = 'invalid-key';
  err.problems = problems;
  return err;
}

function unknown(ref) {
  const err = new Error(`No key matching "${ref}".`);
  err.kind = 'unknown-key';
  return err;
}

/**
 * Resolve a reference to one stored record.
 *
 * An exact id wins, then an exact name (case-insensitive), then a secret prefix,
 * which is what the list shows and the operator can copy. An ambiguous prefix
 * is refused rather than guessed: rotating the wrong key silently breaks a
 * deployment.
 */
export function findKeyRecord(ref, pathOverride) {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  const wanted = ref.trim();
  const { records } = readKeyRecords(pathOverride);
  const byId = records.find((k) => k.id === wanted);
  if (byId) return byId;
  const lowered = wanted.toLowerCase();
  const byName = records.filter((k) => k.name.toLowerCase() === lowered);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const err = new Error(`"${wanted}" matches ${byName.length} keys. Use an id.`);
    err.kind = 'ambiguous-key';
    throw err;
  }
  const byPrefix = records.filter((k) => k.prefix && k.prefix.toLowerCase() === lowered);
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    const err = new Error(`"${wanted}" matches ${byPrefix.length} keys. Use an id.`);
    err.kind = 'ambiguous-key';
    throw err;
  }
  return null;
}

/** One key as the API and the page see it, or null. */
export function findKey(ref, pathOverride, now = Date.now()) {
  let record;
  try {
    record = findKeyRecord(ref, pathOverride);
  } catch {
    return null;
  }
  return publicKey(record, now);
}

/**
 * Make a key. Throws `invalid-key` with every problem when the input is bad.
 *
 * The secret is returned beside the record and never stored, so this return
 * value is the only time it exists in readable form.
 */
export function createKey(input = {}, pathOverride) {
  const store = readKeyRecords(pathOverride);
  if (store.corrupted) {
    const err = new Error(`The key store at ${store.path} is not readable JSON. Fix or remove it before creating keys.`);
    err.kind = 'corrupted-store';
    throw err;
  }
  const problems = validateKeyInput(input, store.records, null);
  if (problems.length > 0) throw invalid(problems);

  const now = new Date().toISOString();
  const secret = generateKeySecret();
  const record = {
    id: newKeyId(),
    name: input.name.trim(),
    prefix: keyDisplayPrefix(secret),
    hash: hashKeySecret(secret),
    assignedTo: normaliseText(input.assignedTo, KEY_ASSIGNMENT_MAX),
    notes: normaliseText(input.notes, KEY_NOTES_MAX),
    createdAt: now,
    updatedAt: now,
    lastRotatedAt: null,
    rotations: 0,
    expiresAt: expiryFrom(input),
    lastUsedAt: null,
    lastUsedFrom: null,
    requestCount: 0
  };
  writeStore(store.path, [...store.records, record]);
  return { key: publicKey(record), secret };
}

/**
 * Issue a new secret for an existing key.
 *
 * The id, name, assignment, and notes survive: rotation is about the secret,
 * not the identity, so a deployment that reads its key from a file only has to
 * see a new value. The old secret stops working immediately — a grace window
 * would mean the operator cannot tell whether the old credential is still live,
 * which is the one question rotation exists to answer.
 */
export function rotateKey(ref, pathOverride, options = {}) {
  const store = readKeyRecords(pathOverride);
  if (store.corrupted) {
    const err = new Error(`The key store at ${store.path} is not readable JSON. Fix or remove it before rotating keys.`);
    err.kind = 'corrupted-store';
    throw err;
  }
  const current = findKeyRecord(ref, pathOverride);
  if (!current) throw unknown(ref);

  if (options.expiresAt !== undefined || options.expiresInDays !== undefined) {
    const problems = expiryProblems(options);
    if (problems.length > 0) throw invalid(problems);
  }

  const now = new Date().toISOString();
  const secret = generateKeySecret();
  const rotated = {
    ...current,
    prefix: keyDisplayPrefix(secret),
    hash: hashKeySecret(secret),
    updatedAt: now,
    lastRotatedAt: now,
    rotations: current.rotations + 1,
    // An expiry is only changed when the caller said something about one, so a
    // plain rotate keeps the window it had; an explicitly empty value removes it.
    expiresAt: (options.expiresAt === undefined && options.expiresInDays === undefined)
      ? current.expiresAt
      : (clearsExpiry(options) ? null : expiryFrom(options))
  };
  writeStore(store.path, store.records.map((k) => (k.id === current.id ? rotated : k)));
  return { key: publicKey(rotated), secret };
}

/**
 * Rename, reassign, re-note, or re-expire a key. The secret is untouched.
 */
export function updateKey(ref, patch = {}, pathOverride) {
  const store = readKeyRecords(pathOverride);
  if (store.corrupted) {
    const err = new Error(`The key store at ${store.path} is not readable JSON. Fix or remove it before editing keys.`);
    err.kind = 'corrupted-store';
    throw err;
  }
  const current = findKeyRecord(ref, pathOverride);
  if (!current) throw unknown(ref);

  const merged = {
    name: patch.name !== undefined ? patch.name : current.name,
    assignedTo: patch.assignedTo !== undefined ? patch.assignedTo : current.assignedTo,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    expiresInDays: patch.expiresInDays,
    expiresAt: patch.expiresAt
  };
  const problems = validateKeyInput(merged, store.records, current.id);
  if (problems.length > 0) throw invalid(problems);

  // `null` and `''` both mean "clear this field", which is how a form reports
  // "no assignment" or "no expiry" without a second flag. An expiry is only
  // touched when the caller said something about one, so a rename cannot
  // silently reset it.
  const cleared = (value) => value === null || value === '';
  const saysNothingAboutExpiry = patch.expiresAt === undefined && patch.expiresInDays === undefined;
  const updated = {
    ...current,
    name: merged.name.trim(),
    assignedTo: patch.assignedTo !== undefined
      ? normaliseText(patch.assignedTo, KEY_ASSIGNMENT_MAX)
      : current.assignedTo,
    notes: patch.notes !== undefined ? normaliseText(patch.notes, KEY_NOTES_MAX) : current.notes,
    expiresAt: saysNothingAboutExpiry
      ? current.expiresAt
      : (cleared(patch.expiresAt) || cleared(patch.expiresInDays) ? null : expiryFrom(merged)),
    updatedAt: new Date().toISOString()
  };
  writeStore(store.path, store.records.map((k) => (k.id === current.id ? updated : k)));
  return publicKey(updated);
}

/** Remove a key. The secret stops working on the next request. */
export function deleteKey(ref, pathOverride) {
  const store = readKeyRecords(pathOverride);
  const current = findKeyRecord(ref, pathOverride);
  if (!current) throw unknown(ref);
  writeStore(store.path, store.records.filter((k) => k.id !== current.id));
  return publicKey(current);
}

/**
 * Authenticate a presented secret.
 *
 * Returns the record it belongs to, or null. Comparison is a digest compare, so
 * it is constant-time in the parts an attacker controls and never indexes a
 * string by its own content. An expired key authenticates nothing.
 */
export function verifyKeySecret(secret, pathOverride, now = Date.now()) {
  if (!looksLikeKey(secret)) return null;
  const { records, corrupted } = readKeyRecords(pathOverride);
  if (corrupted) return null;
  const digest = Buffer.from(hashKeySecret(secret), 'hex');
  for (const record of records) {
    let stored;
    try {
      stored = Buffer.from(record.hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length !== digest.length) continue;
    if (timingSafeEqual(stored, digest)) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) return null;
      return record;
    }
  }
  return null;
}

/* ------------------------------------------------------------------- usage */

/**
 * Pending usage counts, keyed by store path and key id.
 *
 * Module state rather than per-call: the point is to hold writes down across
 * requests in a long-lived server, which is exactly the lifetime of this map.
 */
const pendingUsage = new Map();

/** Usage that has not been written yet, for a test or a shutdown hook. */
export function pendingKeyUsage(pathOverride) {
  const file = keysPath(pathOverride);
  const out = [];
  for (const [composite, entry] of pendingUsage) {
    if (composite.startsWith(`${file}\n`)) {
      out.push({ id: composite.slice(file.length + 1), ...entry });
    }
  }
  return out;
}

/** Throw away unwritten usage counts. Only a test wants this. */
export function resetPendingKeyUsage() {
  pendingUsage.clear();
}

/**
 * Record that a key authenticated a request.
 *
 * `lastUsedAt` is what makes the page answer "is this key still in use, and can
 * I delete it", so it is worth persisting — but not per request. Uses inside the
 * write interval are counted and flushed together on the first request after it,
 * so a polling integration costs at most one write a minute.
 */
export function recordKeyUse(record, pathOverride, options = {}) {
  if (!record || !record.id) return false;
  const file = keysPath(pathOverride);
  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? KEY_USAGE_WRITE_INTERVAL_MS;
  const composite = `${file}\n${record.id}`;
  const pending = pendingUsage.get(composite) || {
    count: 0,
    firstAt: now,
    from: options.from ?? null,
    writtenAt: null
  };
  pending.count += 1;
  if (options.from) pending.from = options.from;

  // `writtenAt` is kept in the pending entry rather than dropped after a write,
  // so the throttle holds even when the caller passes the record it read before
  // the last write. Without that, a caller holding a stale record would rewrite
  // the store on every request, which is the cost this exists to avoid.
  const lastWrite = pending.writtenAt ?? (record.lastUsedAt ? Date.parse(record.lastUsedAt) : null);
  const due = lastWrite === null || Number.isNaN(lastWrite) || now - lastWrite >= interval;
  if (!due) {
    pendingUsage.set(composite, pending);
    return false;
  }

  const store = readKeyRecords(pathOverride);
  const current = store.records.find((k) => k.id === record.id);
  if (!current) {
    // The key was deleted between authenticating and recording: nothing to
    // write, and re-creating it here would resurrect a credential.
    pendingUsage.delete(composite);
    return false;
  }
  const updated = {
    ...current,
    lastUsedAt: new Date(now).toISOString(),
    lastUsedFrom: pending.from ?? current.lastUsedFrom,
    requestCount: current.requestCount + pending.count
  };
  try {
    writeStore(store.path, store.records.map((k) => (k.id === current.id ? updated : k)));
  } catch {
    // Usage is telemetry. A read-only home directory must not fail the request
    // that the credential already authorised.
    pendingUsage.set(composite, pending);
    return false;
  }
  pendingUsage.set(composite, { ...pending, count: 0, writtenAt: now });
  return true;
}
