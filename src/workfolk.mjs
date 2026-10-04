/**
 * Workfolk ↔ zstack bridge client.
 *
 * Connects zstack to the Workfolk (gateway_workers) worker dispatch API and
 * worker roster. Zero runtime dependencies, uses native fetch.
 *
 * Configured via:
 * - WORKFOLK_URL or GATEWAY_WORKERS_URL (default: 'http://127.0.0.1:3000')
 * - WORKFOLK_TOKEN or GATEWAY_WORKERS_TOKEN (bearer authentication)
 */

export const DEFAULT_WORKFOLK_URL = 'http://127.0.0.1:3000';

const TAG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TASK_CHARS = 16000;

/**
 * Resolve the Workfolk configuration from environment variables or options.
 */
export function getWorkfolkConfig(env = process.env) {
  const rawUrl = env.WORKFOLK_URL || env.GATEWAY_WORKERS_URL || DEFAULT_WORKFOLK_URL;
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const token = (env.WORKFOLK_TOKEN || env.GATEWAY_WORKERS_TOKEN || '').trim() || null;
  return {
    baseUrl,
    token,
    configured: Boolean(token)
  };
}

/**
 * Normalize and validate a worker tag (e.g. '@researcher' -> 'researcher').
 */
export function normalizeWorkerTag(rawTag) {
  if (typeof rawTag !== 'string') {
    throw new Error('Worker tag must be a string.');
  }
  const tag = rawTag.trim().replace(/^@/, '').toLowerCase();
  if (!tag || !TAG_REGEX.test(tag)) {
    throw new Error(`Invalid worker tag "${rawTag}". Must start with alphanumeric and contain only letters, numbers, hyphens or underscores (1..64 chars).`);
  }
  return tag;
}

/**
 * Validate a task string.
 */
export function validateTask(rawTask) {
  if (typeof rawTask !== 'string') {
    throw new Error('Task must be a string.');
  }
  const task = rawTask.trim();
  if (!task) {
    throw new Error('Task cannot be empty.');
  }
  if (task.length > MAX_TASK_CHARS) {
    throw new Error(`Task exceeds maximum allowed length of ${MAX_TASK_CHARS} characters (received ${task.length}).`);
  }
  return task;
}

/**
 * Fetch the public worker roster from Workfolk.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.token]
 * @param {boolean} [options.includeRetired]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Array<{ tag: string, name: string, role: string, description: string, tools: string[], status: string }>>}
 */
export async function fetchWorkfolkRoster(options = {}) {
  const config = getWorkfolkConfig();
  const baseUrl = (options.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : config.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const url = `${baseUrl}/api/workers${options.includeRetired ? '?includeRetired=true' : ''}`;
  const headers = { 'Accept': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`Failed to reach Workfolk gateway at ${baseUrl}: ${err.message || String(err)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Workfolk gateway returned invalid JSON (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(`Failed to fetch Workfolk roster: ${msg}`);
  }

  if (!Array.isArray(data)) {
    throw new Error('Expected Workfolk roster to return an array of workers.');
  }

  return data;
}

/**
 * Dispatch a task to a Workfolk worker.
 *
 * @param {string} rawTag
 * @param {string} rawTask
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ job_id: string, status: string }>}
 */
export async function dispatchWorkfolkTask(rawTag, rawTask, options = {}) {
  const worker_tag = normalizeWorkerTag(rawTag);
  const task = validateTask(rawTask);

  const config = getWorkfolkConfig();
  const baseUrl = (options.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : config.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!token) {
    throw new Error('Workfolk bearer token is required to dispatch tasks. Set WORKFOLK_TOKEN or GATEWAY_WORKERS_TOKEN.');
  }

  const url = `${baseUrl}/api/dispatch`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ worker_tag, task })
    });
  } catch (err) {
    throw new Error(`Failed to dispatch to Workfolk at ${baseUrl}: ${err.message || String(err)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Workfolk gateway returned non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const err = new Error(`Workfolk dispatch failed: ${msg}`);
    err.status = res.status;
    throw err;
  }

  if (!data?.job_id) {
    throw new Error('Workfolk dispatch response missing job_id.');
  }

  return {
    job_id: data.job_id,
    status: data.status || 'queued'
  };
}

/**
 * Fetch the status and result of a previously dispatched Workfolk job.
 *
 * @param {string} jobId
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ job_id: string, status: string, result: string | null, cost?: object | null }>}
 */
export async function getWorkfolkJobStatus(jobId, options = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('Job ID is required.');
  }

  const config = getWorkfolkConfig();
  const baseUrl = (options.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : config.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!token) {
    throw new Error('Workfolk bearer token is required to query jobs. Set WORKFOLK_TOKEN or GATEWAY_WORKERS_TOKEN.');
  }

  const url = `${baseUrl}/api/jobs/${encodeURIComponent(jobId.trim())}`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`Failed to query Workfolk job at ${baseUrl}: ${err.message || String(err)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Workfolk gateway returned non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const err = new Error(`Failed to retrieve job "${jobId}": ${msg}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

/**
 * Poll a Workfolk job until it reaches a terminal status or times out.
 *
 * Terminal statuses: 'completed', 'failed', 'cancelled', 'expired'.
 *
 * @param {string} jobId
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {function} [options.onPoll]
 * @param {string} [options.baseUrl]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ job_id: string, status: string, result: string | null }>}
 */
export async function pollWorkfolkJob(jobId, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 120000;
  const intervalMs = Math.max(20, Number(options.intervalMs) || 1000);
  const onPoll = typeof options.onPoll === 'function' ? options.onPoll : null;
  const startTime = Date.now();

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'expired']);

  while (Date.now() - startTime < timeoutMs) {
    const record = await getWorkfolkJobStatus(jobId, options);
    if (onPoll) {
      try {
        onPoll(record);
      } catch {}
    }

    if (terminalStatuses.has(record.status)) {
      return record;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Workfolk job "${jobId}" timed out after ${timeoutMs}ms.`);
}

/**
 * Verify authentication with the Workfolk gateway.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
export async function verifyWorkfolkAuth(options = {}) {
  const config = getWorkfolkConfig();
  const baseUrl = (options.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : config.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!token) {
    return { valid: false, error: 'No token configured.' };
  }

  const url = `${baseUrl}/api/workers/auth/verify`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  try {
    const res = await fetchImpl(url, { method: 'GET', headers });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { valid: data?.valid === true };
    }
    const errData = await res.json().catch(() => ({}));
    return { valid: false, error: errData?.error || `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, error: err.message || String(err) };
  }
}

/**
 * Retrieve high-level health and status of the Workfolk bridge.
 *
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, configured: boolean, baseUrl: string, hasToken: boolean, workerCount: number, error?: string }>}
 */
export async function getWorkfolkStatus(options = {}) {
  const config = getWorkfolkConfig();
  const baseUrl = (options.baseUrl || config.baseUrl).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : config.token;

  let workers = [];
  let error = null;
  let ok = false;

  try {
    workers = await fetchWorkfolkRoster({ ...options, baseUrl, token });
    ok = true;
  } catch (err) {
    error = err.message || String(err);
  }

  let authValid = null;
  if (token && ok) {
    const auth = await verifyWorkfolkAuth({ ...options, baseUrl, token });
    authValid = auth.valid;
  }

  return {
    ok,
    configured: Boolean(token),
    baseUrl,
    hasToken: Boolean(token),
    authValid,
    workerCount: workers.length,
    workers: ok ? workers : [],
    ...(error ? { error } : {})
  };
}
