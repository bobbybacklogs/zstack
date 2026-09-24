import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { fetchModelHitchState, resolveRoleMapping, sendChat } from './connector.mjs';
import { getStoredBudget, resolveBudgetMapping } from './budget.mjs';
import { estimateTokens, extractHeader } from './context.mjs';

export const OFFLOAD_DEFAULT_ROLE = 'how explorer';
export const OFFLOAD_DEFAULT_BUDGET_TOKENS = 4000;
export const OFFLOAD_DEFAULT_MAX_FILES = 40;
export const OFFLOAD_DEFAULT_MAX_FILE_BYTES = 200000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(w => w.length > 2);
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '') || '.';
}

/**
 * Walk paths with node:fs/promises. Skips node_modules, .git, dist, build,
 * and dotfiles unless that exact path was explicitly passed.
 */
export async function walkPaths(paths, options = {}) {
  const explicit = new Set((paths || []).map(normalize));
  const seen = new Set();
  const files = [];

  async function walkDir(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = normalize(relative(process.cwd(), full));
      if (entry.isDirectory()) {
        const skipName = SKIP_DIRS.has(entry.name) || entry.name.startsWith('.');
        if (skipName && !explicit.has(rel) && !explicit.has(normalize(full))) continue;
        await walkDir(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') && !explicit.has(rel) && !explicit.has(normalize(full))) continue;
        if (!seen.has(full)) {
          seen.add(full);
          files.push(full);
        }
      }
    }
  }

  for (const p of paths || []) {
    const norm = normalize(p);
    let st = null;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkDir(p);
    } else if (st.isFile()) {
      if (!seen.has(p)) {
        seen.add(p);
        files.push(p);
      }
    }
    void norm;
  }
  return files;
}

function isBinarySample(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Rank files by case-insensitive keyword overlap with the query.
 * Filename hits weigh 3x; hits in the first 200 lines weigh 1x.
 */
export function rankOffloadFiles(query, filesWithText) {
  const queryTokens = new Set(tokenize(query));
  const ranked = [];
  for (const { file, content } of filesWithText) {
    const nameTokens = tokenize(basename(file));
    let fileHits = 0;
    for (const t of queryTokens) {
      if (nameTokens.some(n => n.includes(t) || t.includes(n))) fileHits++;
    }
    const head = String(content).split('\n').slice(0, 200).join('\n').toLowerCase();
    let contentHits = 0;
    for (const t of queryTokens) {
      if (head.includes(t)) contentHits++;
    }
    const score = fileHits * 3 + contentHits;
    if (score > 0) ranked.push({ file, score, fileHits, contentHits });
  }
  ranked.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
  return ranked;
}

function truncateExcerpt(file, content, maxChars) {
  const totalLines = String(content).split('\n').length;
  if (content.length <= maxChars) return { excerpt: content, truncated: false, totalLines };
  const header = extractHeader(content);
  const slice = content.slice(0, Math.max(0, maxChars - header.length - 120));
  const keptLines = slice.split('\n').length;
  return {
    excerpt: `${header}\n${slice}\n[... omitted lines ${keptLines + 1}-${totalLines} of ${file} ...]`,
    truncated: true,
    totalLines
  };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in subagent response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateOffload(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Offload response must be an object');
  if (!Array.isArray(parsed.findings)) throw new Error('Offload response missing findings array');
  if (typeof parsed.answer !== 'string') throw new Error('Offload response missing answer string');
  for (const f of parsed.findings) {
    if (!f || typeof f.file !== 'string' || typeof f.claim !== 'string') {
      throw new Error('Offload finding must have file and claim strings');
    }
  }
  return {
    findings: parsed.findings.map(f => ({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      claim: f.claim,
      confidence: typeof f.confidence === 'number' ? f.confidence : null
    })),
    answer: parsed.answer,
    uncovered: Array.isArray(parsed.uncovered) ? parsed.uncovered.map(String) : []
  };
}

function buildOffloadPrompt(query, excerpts) {
  const blocks = excerpts
    .map(e => `--- file: ${e.file}${e.truncated ? ' (truncated)' : ''} ---\n${e.excerpt}`)
    .join('\n\n');
  return `You are a context offload subagent. Answer the query using ONLY the file excerpts below. Reply with ONLY a JSON object shaped {"findings": [{"file": "<path>", "line": <number or null>, "claim": "<single sentence>", "confidence": <0-1>}], "answer": "<distilled answer, 3-6 sentences>", "uncovered": ["<what the excerpts did not cover>", ...]}. Never invent files or lines not present in the excerpts.

<QUERY>
${query}
</QUERY>

<EXCERPTS>
${blocks}
</EXCERPTS>`;
}

/**
 * Delegate bulk file reads to a narrow subagent that returns only a distilled
 * report. Raw file bodies never leave this function.
 */
export async function runContextOffload(options = {}, deps = {}) {
  const {
    query,
    paths = ['.'],
    maxFiles = OFFLOAD_DEFAULT_MAX_FILES,
    maxFileBytes = OFFLOAD_DEFAULT_MAX_FILE_BYTES,
    budgetTokens = OFFLOAD_DEFAULT_BUDGET_TOKENS,
    model,
    role = OFFLOAD_DEFAULT_ROLE,
    signal,
    fetchImpl,
    timeoutMs,
    baseUrl,
    rootDir
  } = options;

  if (!query || !String(query).trim()) {
    throw new Error('Offload query is required');
  }

  const allFiles = await walkPaths(paths, options);
  const filesScanned = allFiles.length;
  const omitted = [];
  const texts = [];
  for (const file of allFiles) {
    let buf;
    try {
      buf = await readFile(file);
    } catch (err) {
      omitted.push(`unreadable ${file}: ${err?.message || 'unknown'}`);
      continue;
    }
    if (isBinarySample(buf)) {
      omitted.push(`skipped binary ${file}`);
      continue;
    }
    let content = buf.toString('utf8');
    if (content.length > maxFileBytes) {
      content = content.slice(0, maxFileBytes);
      omitted.push(`truncated ${file} to maxFileBytes (${maxFileBytes})`);
    }
    texts.push({ file: normalize(relative(process.cwd(), file)), content });
  }

  const ranked = rankOffloadFiles(query, texts).slice(0, Math.max(0, maxFiles));
  if (ranked.length === 0) {
    return {
      ok: true,
      answer: 'No matching files for query.',
      findings: [],
      filesScanned,
      filesAttached: 0,
      estimatedTokens: 0,
      omitted,
      model: model || null,
      role,
      durationMs: 0
    };
  }

  const byteCap = Math.max(1, budgetTokens * 4);
  const excerpts = [];
  let used = 0;
  for (const r of ranked) {
    const original = texts.find(t => t.file === r.file);
    if (!original) continue;
    const remaining = byteCap - used;
    if (remaining <= 0) {
      omitted.push(`omitted ${r.file}: byte cap reached`);
      continue;
    }
    const t = truncateExcerpt(r.file, original.content, remaining);
    if (t.truncated) omitted.push(`truncated ${r.file} to fit byte cap`);
    excerpts.push({ file: r.file, excerpt: t.excerpt, truncated: t.truncated });
    used += t.excerpt.length;
  }

  const estimatedTokens = estimateTokens(excerpts.map(e => e.excerpt).join('\n\n'));
  const prompt = buildOffloadPrompt(String(query).trim(), excerpts);

  const fetchState = deps.fetchState || ((url) => fetchModelHitchState(url, { timeoutMs, fetchImpl }));
  const chat = deps.chat || (({ model: m, messages }) => sendChat({ model: m, messages, baseUrl, timeoutMs, fetchImpl, signal }));

  const state = await fetchState(baseUrl);
  let targetModel = model;
  if (!targetModel) {
    try {
      const budget = resolveBudgetMapping({ tier: getStoredBudget().tier, source: getStoredBudget().source, state });
      targetModel = budget.models[role] || budget.models['feature, refactoring'];
    } catch {
      targetModel = resolveRoleMapping(state).models[role] || resolveRoleMapping(state).models['feature, refactoring'];
    }
  }

  const messages = [{ role: 'user', content: prompt }];
  const startTime = Date.now();
  const attempt = () => chat({ model: targetModel, messages });
  let parsed;
  try {
    const first = await attempt();
    parsed = validateOffload(extractJsonObject(typeof first === 'string' ? first : first?.content));
  } catch {
    try {
      const second = await attempt();
      parsed = validateOffload(extractJsonObject(typeof second === 'string' ? second : second?.content));
    } catch {
      return {
        ok: false,
        error: 'parse-error',
        answer: '',
        findings: [],
        filesScanned,
        filesAttached: excerpts.length,
        estimatedTokens,
        omitted,
        model: targetModel,
        role,
        durationMs: Date.now() - startTime
      };
    }
  }

  return {
    ok: true,
    answer: parsed.answer,
    findings: parsed.findings,
    uncovered: parsed.uncovered,
    filesScanned,
    filesAttached: excerpts.length,
    estimatedTokens,
    omitted,
    model: targetModel,
    role,
    durationMs: Date.now() - startTime
  };
}

/** Human-readable rendering of an offload report (answer + findings table). */
export function formatOffloadReport(result) {
  const lines = [];
  if (result.ok === false) {
    lines.push(`[!] Offload failed: ${result.error || 'unknown error'}`);
    return lines.join('\n');
  }
  lines.push(result.answer || '(no answer)');
  lines.push('');
  lines.push('  file                                     claim');
  for (const f of result.findings || []) {
    const where = f.line != null ? `${f.file}:${f.line}` : f.file;
    lines.push(`  ${String(where).padEnd(40).slice(0, 40)} ${(f.claim || '').slice(0, 90)}`);
  }
  if ((result.uncovered || []).length > 0) {
    lines.push('');
    lines.push(`  uncovered: ${result.uncovered.join('; ').slice(0, 200)}`);
  }
  return lines.join('\n');
}
