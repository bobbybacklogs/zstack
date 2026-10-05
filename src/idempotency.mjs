import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { historyPath } from './history.mjs';

/** One exclusive-create record per key, persisted before execution begins. */
export function idempotencyPath(pathOverride, historyFile) {
  return pathOverride || process.env.ZSTACK_IDEMPOTENCY_PATH || join(dirname(historyPath(historyFile)), 'run-idempotency');
}

function fileFor(key, directory) {
  return join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
}

export function requestFingerprint(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function readRunAdmission(key, directory) {
  let raw;
  try { raw = readFileSync(fileFor(key, directory), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const record = JSON.parse(raw);
  if (!record || typeof record.id !== 'string' || !record.id || !/^[a-f0-9]{64}$/.test(record.fingerprint)) {
    throw new Error('Invalid run idempotency record. Refusing to repeat execution.');
  }
  return record;
}

export function reserveRunAdmission(key, record, directory) {
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(fileFor(key, directory), JSON.stringify(record) + '\n', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** Only an admission that failed synchronously before execution may be released. */
export function releaseRunAdmission(key, directory) {
  unlinkSync(fileFor(key, directory));
}
