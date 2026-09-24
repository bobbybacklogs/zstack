import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPromptSemantic,
  getPlaybookEmbeddings,
  cosineSimilarity
} from '../src/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

function embedFor(text) {
  const t = String(text).toLowerCase();
  const count = re => (t.match(re) || []).length;
  // No smoothing: unrelated triggers yield zero vectors (cosine 0) so related
  // playbooks always outrank them.
  return [
    count(/perf|performance|slow|latency|bottleneck|leak|throughput|cpu/g),
    count(/memory/g),
    count(/css|styling|pixel|visual|responsive/g),
    count(/bug|fix|broken|error|crash|regression/g)
  ];
}

let server;
let baseUrl;
let requests = 0;

before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      requests++;
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: inputs.map((t, i) => ({ embedding: embedFor(String(t)) })) }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('embedding playbook router', () => {
  it('ranks the memory prompt above styling playbooks', async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'zstack-router-')), 'embeddings.json');
    const out = await classifyPromptSemantic('memory growing during batch imports', {
      baseUrl,
      rootDir: ROOT_DIR,
      cachePath
    });
    assert.ok(out, 'should return a ranking when the gateway is reachable');
    const order = out.candidates.map(c => c.type);
    const perfIdx = order.indexOf('perf-issue');
    const visualIdx = order.indexOf('visual-parity');
    assert.ok(perfIdx !== -1, 'perf-issue should be ranked');
    if (visualIdx !== -1) {
      assert.ok(perfIdx < visualIdx, `perf-issue (${perfIdx}) should lead visual-parity (${visualIdx})`);
    }
    assert.ok(out.score > 0.3, `top score should be meaningful (got ${out.score})`);
  });

  it('reuses cached playbook embeddings without refetching', async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'zstack-router-')), 'embeddings.json');
    requests = 0;
    await getPlaybookEmbeddings({ baseUrl, rootDir: ROOT_DIR, cachePath });
    const firstCount = requests;
    assert.ok(firstCount >= 1, 'first call should fetch trigger embeddings');
    await getPlaybookEmbeddings({ baseUrl, rootDir: ROOT_DIR, cachePath });
    assert.equal(requests, firstCount, 'second call should reuse the cache with zero new requests');
  });

  it('falls back silently (null) when the gateway is down', async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'zstack-router-')), 'embeddings.json');
    const out = await classifyPromptSemantic('memory growing during batch imports', {
      baseUrl: 'http://127.0.0.1:9',
      rootDir: ROOT_DIR,
      cachePath
    });
    assert.equal(out, null, 'unreachable gateway must yield null so keyword results stand');
  });

  it('computes cosine similarity correctly', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
  });
});
