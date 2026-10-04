import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DEFAULT_WORKFOLK_URL,
  getWorkfolkConfig,
  normalizeWorkerTag,
  validateTask,
  fetchWorkfolkRoster,
  dispatchWorkfolkTask,
  getWorkfolkJobStatus,
  pollWorkfolkJob,
  verifyWorkfolkAuth,
  getWorkfolkStatus
} from '../src/workfolk.mjs';
import { createApp, startServer } from '../src/serve.mjs';
import { ZStack } from '../src/sdk.mjs';

function createMockWorkfolkGateway() {
  const jobs = new Map();
  const workers = [
    {
      tag: 'coordinator',
      name: 'Coordinator',
      role: 'Team Lead',
      description: 'Lead Task Router',
      tools: ['orchestration', 'planning'],
      status: 'active'
    },
    {
      tag: 'developer',
      name: 'Developer',
      role: 'Software Engineer',
      description: 'Codes and builds',
      tools: ['coding', 'testing'],
      status: 'active'
    },
    {
      tag: 'retired-agent',
      name: 'Old Agent',
      role: 'Archived',
      description: 'Retired',
      tools: [],
      status: 'retired'
    }
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';

    // Auth check
    const isAuthed = auth === 'Bearer secret-wf-token';

    if (url.pathname === '/api/workers/auth/verify') {
      if (!isAuthed) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true }));
      return;
    }

    if (url.pathname === '/api/workers') {
      const includeRetired = url.searchParams.get('includeRetired') === 'true';
      const filtered = includeRetired ? workers : workers.filter((w) => w.status !== 'retired');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(filtered));
      return;
    }

    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      if (!isAuthed) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bearer authentication required' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const tag = parsed.worker_tag;
        const task = parsed.task;
        const targetWorker = workers.find((w) => w.tag === tag);
        if (!targetWorker || targetWorker.status === 'retired') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown or retired worker' }));
          return;
        }

        const jobId = `job_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          job_id: jobId,
          worker_tag: tag,
          task,
          status: 'queued',
          result: null,
          created_at: new Date().toISOString()
        };
        jobs.set(jobId, record);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ job_id: jobId, status: 'queued' }));
      });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      if (!isAuthed) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bearer authentication required' }));
        return;
      }
      const id = decodeURIComponent(jobMatch[1]);
      const job = jobs.get(id);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    jobs,
    workers,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('normalizeWorkerTag: normalizes and validates tags', () => {
  assert.equal(normalizeWorkerTag('researcher'), 'researcher');
  assert.equal(normalizeWorkerTag('@developer'), 'developer');
  assert.equal(normalizeWorkerTag('@Coordinator'), 'coordinator');
  assert.equal(normalizeWorkerTag('infra_123'), 'infra_123');

  assert.throws(() => normalizeWorkerTag(''), /Invalid worker tag/);
  assert.throws(() => normalizeWorkerTag('@'), /Invalid worker tag/);
  assert.throws(() => normalizeWorkerTag('@-invalid'), /Invalid worker tag/);
  assert.throws(() => normalizeWorkerTag(null), /must be a string/);
});

test('validateTask: validates task lengths and content', () => {
  assert.equal(validateTask('Fix the build'), 'Fix the build');
  assert.equal(validateTask('  Trimmed prompt  '), 'Trimmed prompt');

  assert.throws(() => validateTask(''), /cannot be empty/);
  assert.throws(() => validateTask('   '), /cannot be empty/);
  assert.throws(() => validateTask(123), /must be a string/);
  assert.throws(() => validateTask('a'.repeat(16001)), /exceeds maximum allowed length/);
});

test('getWorkfolkConfig: resolves environment variables and defaults', () => {
  const emptyConf = getWorkfolkConfig({});
  assert.equal(emptyConf.baseUrl, DEFAULT_WORKFOLK_URL);
  assert.equal(emptyConf.token, null);
  assert.equal(emptyConf.configured, false);

  const envConf = getWorkfolkConfig({
    WORKFOLK_URL: 'http://my-host:3000/',
    WORKFOLK_TOKEN: 'wf-token-abc'
  });
  assert.equal(envConf.baseUrl, 'http://my-host:3000');
  assert.equal(envConf.token, 'wf-token-abc');
  assert.equal(envConf.configured, true);

  const gatewayWorkersEnv = getWorkfolkConfig({
    GATEWAY_WORKERS_URL: 'http://gw-host:8080',
    GATEWAY_WORKERS_TOKEN: 'gw-token-xyz'
  });
  assert.equal(gatewayWorkersEnv.baseUrl, 'http://gw-host:8080');
  assert.equal(gatewayWorkersEnv.token, 'gw-token-xyz');
  assert.equal(gatewayWorkersEnv.configured, true);
});

test('fetchWorkfolkRoster: fetches active workers and honors includeRetired', async () => {
  const mock = createMockWorkfolkGateway();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const activeWorkers = await fetchWorkfolkRoster({ baseUrl });
    assert.equal(activeWorkers.length, 2);
    assert.equal(activeWorkers[0].tag, 'coordinator');
    assert.equal(activeWorkers[1].tag, 'developer');

    const allWorkers = await fetchWorkfolkRoster({ baseUrl, includeRetired: true });
    assert.equal(allWorkers.length, 3);
    assert.equal(allWorkers.some((w) => w.tag === 'retired-agent'), true);
  } finally {
    await mock.close();
  }
});

test('dispatchWorkfolkTask: dispatches task and returns queued job', async () => {
  const mock = createMockWorkfolkGateway();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'secret-wf-token';

  try {
    // Missing token throws
    await assert.rejects(
      () => dispatchWorkfolkTask('@developer', 'Run test suite', { baseUrl, token: null }),
      /token is required/
    );

    // Unknown worker fails with 404
    await assert.rejects(
      () => dispatchWorkfolkTask('@nonexistent', 'Do something', { baseUrl, token }),
      /Unknown or retired worker/
    );

    // Valid dispatch succeeds
    const res = await dispatchWorkfolkTask('@developer', 'Check linting', { baseUrl, token });
    assert.ok(res.job_id.startsWith('job_test_'));
    assert.equal(res.status, 'queued');

    // Retrieve created job
    const job = await getWorkfolkJobStatus(res.job_id, { baseUrl, token });
    assert.equal(job.job_id, res.job_id);
    assert.equal(job.worker_tag, 'developer');
    assert.equal(job.task, 'Check linting');
    assert.equal(job.status, 'queued');
  } finally {
    await mock.close();
  }
});

test('pollWorkfolkJob: waits for terminal status', async () => {
  const mock = createMockWorkfolkGateway();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'secret-wf-token';

  try {
    const res = await dispatchWorkfolkTask('@coordinator', 'Plan sprint', { baseUrl, token });

    // Transition job to running then completed in background
    setTimeout(() => {
      const j = mock.jobs.get(res.job_id);
      if (j) j.status = 'running';
    }, 50);

    setTimeout(() => {
      const j = mock.jobs.get(res.job_id);
      if (j) {
        j.status = 'completed';
        j.result = 'Sprint planning completed with 4 milestones.';
      }
    }, 150);

    const polled = await pollWorkfolkJob(res.job_id, {
      baseUrl,
      token,
      intervalMs: 30,
      timeoutMs: 2000
    });

    assert.equal(polled.status, 'completed');
    assert.equal(polled.result, 'Sprint planning completed with 4 milestones.');
  } finally {
    await mock.close();
  }
});

test('verifyWorkfolkAuth: validates token against mock gateway', async () => {
  const mock = createMockWorkfolkGateway();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const validCheck = await verifyWorkfolkAuth({ baseUrl, token: 'secret-wf-token' });
    assert.equal(validCheck.valid, true);

    const invalidCheck = await verifyWorkfolkAuth({ baseUrl, token: 'wrong-token' });
    assert.equal(invalidCheck.valid, false);

    const noToken = await verifyWorkfolkAuth({ baseUrl, token: null });
    assert.equal(noToken.valid, false);
  } finally {
    await mock.close();
  }
});

test('getWorkfolkStatus: aggregates status and connection info', async () => {
  const mock = createMockWorkfolkGateway();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'secret-wf-token';

  try {
    const status = await getWorkfolkStatus({ baseUrl, token });
    assert.equal(status.ok, true);
    assert.equal(status.configured, true);
    assert.equal(status.authValid, true);
    assert.equal(status.workerCount, 2);
    assert.equal(status.workers.length, 2);
  } finally {
    await mock.close();
  }
});

test('HTTP API: /api/workfolk routes on zstack serve', async () => {
  const mock = createMockWorkfolkGateway();
  const mockPort = await mock.listen();
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  const mockToken = 'secret-wf-token';

  // Temporarily set env for server routes
  const prevUrl = process.env.WORKFOLK_URL;
  const prevToken = process.env.WORKFOLK_TOKEN;
  process.env.WORKFOLK_URL = mockBaseUrl;
  process.env.WORKFOLK_TOKEN = mockToken;

  const zstackServer = await startServer({
    port: 0,
    host: '127.0.0.1',
    enableScheduler: false
  });

  try {
    const base = `http://127.0.0.1:${zstackServer.port}`;

    // 1. GET /api/workfolk/status
    const statusRes = await fetch(`${base}/api/workfolk/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.workerCount, 2);

    // 2. GET /api/workfolk/workers
    const workersRes = await fetch(`${base}/api/workfolk/workers`);
    assert.equal(workersRes.status, 200);
    const workersBody = await workersRes.json();
    assert.equal(workersBody.ok, true);
    assert.equal(workersBody.workers.length, 2);

    // 3. POST /api/workfolk/dispatch (invalid body)
    const badDispatch = await fetch(`${base}/api/workfolk/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'missing tag' })
    });
    assert.equal(badDispatch.status, 400);

    // 4. POST /api/workfolk/dispatch (valid queued)
    const dispatchRes = await fetch(`${base}/api/workfolk/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_tag: '@developer', task: 'Run integration test' })
    });
    assert.equal(dispatchRes.status, 202);
    const dispatchBody = await dispatchRes.json();
    assert.equal(dispatchBody.ok, true);
    assert.ok(dispatchBody.job_id);

    // 5. GET /api/workfolk/jobs/:id
    const jobRes = await fetch(`${base}/api/workfolk/jobs/${dispatchBody.job_id}`);
    assert.equal(jobRes.status, 200);
    const jobBody = await jobRes.json();
    assert.equal(jobBody.ok, true);
    assert.equal(jobBody.job_id, dispatchBody.job_id);
    assert.equal(jobBody.status, 'queued');

    // 6. POST /api/workfolk/dispatch with wait: true
    setTimeout(() => {
      // Complete all jobs created
      for (const [, j] of mock.jobs) {
        if (j.status === 'queued') {
          j.status = 'completed';
          j.result = 'All tests passed!';
        }
      }
    }, 60);

    const waitDispatch = await fetch(`${base}/api/workfolk/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_tag: '@coordinator',
        task: 'Coordinate build',
        wait: true,
        timeoutMs: 10000,
        intervalMs: 30
      })
    });
    assert.equal(waitDispatch.status, 200);
    const waitBody = await waitDispatch.json();
    assert.equal(waitBody.ok, true);
    assert.equal(waitBody.status, 'completed');
    assert.equal(waitBody.result, 'All tests passed!');
  } finally {
    if (prevUrl) process.env.WORKFOLK_URL = prevUrl; else delete process.env.WORKFOLK_URL;
    if (prevToken) process.env.WORKFOLK_TOKEN = prevToken; else delete process.env.WORKFOLK_TOKEN;
    await new Promise((resolve) => zstackServer.server.close(resolve));
    await mock.close();
  }
});
