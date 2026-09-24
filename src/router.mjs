import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BRIDGE_URL, gatewayFetch } from './connector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROUTER_CACHE_FILE = join(__dirname, '..', 'verification', 'playbook-embeddings.json');
export const ROUTER_EMBEDDING_MODEL = process.env.ZSTACK_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
/** Minimum cosine score for the semantic router to override an ambiguous keyword match. */
export const ROUTER_MIN_SCORE = 0.35;

export function hashContent(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function readCache(cachePath) {
  try {
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf8'));
    }
  } catch {
    // Corrupt cache falls back to refetch; never throws.
  }
  return null;
}

function listPlaybookTriggers(rootDir) {
  const dir = join(rootDir, 'playbooks');
  if (!existsSync(dir)) return null;
  const out = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    let content = '';
    try {
      content = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const triggerMatch = content.match(/> \*\*Trigger:\*\*\s*(.+)/i);
    if (!triggerMatch) continue; // playbook with no trigger line is skipped, never crashes
    out.push({ id, trigger: triggerMatch[1].trim(), hash: hashContent(content) });
  }
  return out;
}

/**
 * Call the ModelHitch gateway embeddings endpoint. Single attempt, bounded
 * timeout; throws on unreachable gateway, non-200 responses, or malformed
 * vectors so callers can fall back.
 */
export async function fetchEmbeddings(texts, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;
  const model = options.model || ROUTER_EMBEDDING_MODEL;
  const { data } = await gatewayFetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    parse: 'json',
    baseUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
  const items = Array.isArray(data?.data) ? data.data : null;
  if (!items || items.length !== texts.length) {
    throw new Error('Malformed embeddings response');
  }
  const vectors = items.map(d => d?.embedding);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0 || !v.every(n => Number.isFinite(Number(n)))) {
      throw new Error('Malformed embedding vector');
    }
  }
  return vectors.map(v => v.map(Number));
}

/**
 * Load (and refresh as needed) cached embeddings for each playbook trigger line.
 * Cache entries are keyed by playbook id and invalidated by content hash.
 */
export async function getPlaybookEmbeddings(options = {}) {
  const rootDir = options.rootDir || join(__dirname, '..');
  const cachePath = options.cachePath || ROUTER_CACHE_FILE;
  const model = options.model || ROUTER_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl || DEFAULT_BRIDGE_URL;

  const triggers = listPlaybookTriggers(rootDir);
  if (!triggers || triggers.length === 0) return null;

  const cache = readCache(cachePath);
  const cachedEntries = cache?.model === model && cache?.entries ? cache.entries : {};

  const vectors = {};
  const missing = [];
  for (const t of triggers) {
    const hit = cachedEntries[t.id];
    if (hit && hit.hash === t.hash && Array.isArray(hit.vector)) {
      vectors[t.id] = { trigger: t.trigger, hash: t.hash, vector: hit.vector };
    } else {
      missing.push(t);
    }
  }

  if (missing.length > 0) {
    const fetched = await fetchEmbeddings(missing.map(m => m.trigger), { baseUrl, model, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl, signal: options.signal });
    const nextEntries = { ...cachedEntries };
    missing.forEach((m, i) => {
      vectors[m.id] = { trigger: m.trigger, hash: m.hash, vector: fetched[i] };
      nextEntries[m.id] = { hash: m.hash, trigger: m.trigger, vector: fetched[i] };
    });
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ model, entries: nextEntries }, null, 2) + '\n', 'utf8');
    } catch {
      // Cache write failure is non-fatal; vectors are still usable in memory.
    }
  }

  return vectors;
}

/**
 * Rank playbooks semantically against the prompt. Returns null when embeddings
 * are unavailable so the caller silently keeps the keyword result.
 */
export async function classifyPromptSemantic(prompt, options = {}) {
  try {
    const text = String(prompt || '').trim();
    if (!text) return null;
    const topN = options.topN || 3;
    const vectors = await getPlaybookEmbeddings(options);
    if (!vectors) return null;
    const [promptVector] = await fetchEmbeddings([text], {
      baseUrl: options.baseUrl || DEFAULT_BRIDGE_URL,
      model: options.model || ROUTER_EMBEDDING_MODEL,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      signal: options.signal
    });
    const scored = Object.entries(vectors).map(([id, entry]) => ({
      type: id,
      score: Math.round(cosineSimilarity(promptVector, entry.vector) * 1000) / 1000,
      reason: `semantic similarity ${Math.round(cosineSimilarity(promptVector, entry.vector) * 1000) / 1000} to trigger: ${entry.trigger.slice(0, 80)}`
    }));
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, topN);
    if (candidates.length === 0) return null;
    return { type: candidates[0].type, score: candidates[0].score, candidates };
  } catch {
    return null;
  }
}
