import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchModelHitchState, resolveRoleMapping, sendChat } from './connector.mjs';
import { getStoredBudget, resolveBudgetMapping } from './budget.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Max diff chars per chunk before hunk-chunking kicks in. */
export const GRADER_MAX_CHUNK_CHARS = 12000;
/** How many top-ranked principles are sent to the reviewer. */
export const GRADER_MAX_PRINCIPLES = 6;
export const GRADER_VERDICTS = ['pass', 'warn', 'fail'];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(w => w.length > 2);
}

/**
 * Split a unified diff into file chunks; oversized files split further by hunk.
 * Every chunk carries an explicit marker so merged verdicts stay auditable.
 */
export function splitDiffIntoChunks(diffText, maxChars = GRADER_MAX_CHUNK_CHARS) {
  const text = String(diffText || '');
  if (!text.trim()) return [];
  const parts = text.split(/^diff --git /m).filter(Boolean);
  const files = parts.length > 0 ? parts.map(p => 'diff --git ' + p) : [text];
  const chunks = [];
  for (const file of files) {
    if (file.length <= maxChars) {
      chunks.push({ header: file.split('\n')[0].slice(0, 120), body: file });
      continue;
    }
    const hunks = file.split(/^@@ /m).filter(Boolean);
    let current = '';
    for (const hunk of hunks) {
      const piece = (current ? '' : '') + '@@ ' + hunk;
      if ((current + piece).length > maxChars && current) {
        chunks.push({ header: current.split('\n')[0].slice(0, 120), body: current, truncated: true });
        current = piece;
      } else {
        current += piece;
      }
    }
    if (current) chunks.push({ header: current.split('\n')[0].slice(0, 120), body: current, truncated: true });
  }
  return chunks.map((c, i) => ({ index: i, total: chunks.length, ...c }));
}

/**
 * Rank principle files by keyword overlap with the diff. Unknown or renamed
 * principle files on disk are simply scored as-is; callers pass explicit
 * principle ids only when provided.
 */
export function rankPrinciples(diffText, options = {}) {
  const principlesDir = options.principlesDir || join(__dirname, '..', 'principles');
  const topN = options.topN || GRADER_MAX_PRINCIPLES;
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null;
  if (!existsSync(principlesDir)) return [];
  const diffWords = new Set(tokenize(diffText));
  const scored = [];
  for (const file of readdirSync(principlesDir).filter(f => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    if (only && !only.has(id)) continue;
    let content = '';
    try {
      content = readFileSync(join(principlesDir, file), 'utf8');
    } catch {
      continue;
    }
    const words = tokenize(id + ' ' + content);
    const wordSet = new Set(words);
    let overlap = 0;
    for (const w of diffWords) {
      if (wordSet.has(w)) overlap++;
    }
    scored.push({ id, score: overlap, snippet: content.slice(0, 1200) });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.slice(0, topN);
}

export function validateVerdicts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'Verdicts must be a non-empty array' };
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (!v || typeof v !== 'object') return { ok: false, error: `Verdict ${i} must be an object` };
    if (typeof v.principle !== 'string' || !v.principle) return { ok: false, error: `Verdict ${i} missing principle` };
    if (typeof v.applies !== 'boolean') return { ok: false, error: `Verdict ${i} missing applies boolean` };
    if (!GRADER_VERDICTS.includes(v.verdict)) return { ok: false, error: `Verdict ${i} has invalid verdict (want pass|warn|fail)` };
    if (typeof v.rationale !== 'string' || !v.rationale) return { ok: false, error: `Verdict ${i} missing rationale` };
    if (!Array.isArray(v.evidence)) return { ok: false, error: `Verdict ${i} missing evidence lines array` };
  }
  return { ok: true, verdicts: value };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array found in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildGradingPrompt({ excerpt, principles, chunked }) {
  const principleBlock = principles
    .map(p => `--- principle: ${p.id} (overlap ${p.score}) ---\n${p.snippet}`)
    .join('\n\n');
  return `You are a zstack principle reasoning grader. Grade the proposed diff against each listed engineering principle.
${chunked ? 'NOTE: the diff exceeded the review window and was chunked by file hunk; verdicts merge across chunks and chunked evidence is marked.' : 'Review the full diff below.'}
Return ONLY a JSON array with one object per principle. Each object must have exactly:
{"principle": "<id>", "applies": true|false, "verdict": "pass"|"warn"|"fail", "rationale": "<one or two sentences>", "evidence": ["<diff line or hunk header>", ...]}
Rules: set applies=false with verdict pass when the principle is irrelevant; never invent diff lines; use verbatim evidence or hunk headers; no prose outside the array.

<DIFF>
${excerpt}
</DIFF>

<PRINCIPLES>
${principleBlock}
</PRINCIPLES>`;
}

/**
 * Grade a diff against the repository principles. Accepts an injectable
 * chat function for tests: options.chat({model, messages}) -> {content}.
 */
export async function gradeDiff(diffText, options = {}) {
  const text = String(diffText || '');
  if (!text.trim()) {
    throw new Error('Empty diff: nothing to grade');
  }
  const principlesDir = options.principlesDir || join(__dirname, '..', 'principles');
  const topN = options.topN || GRADER_MAX_PRINCIPLES;
  const ranked = rankPrinciples(text, { principlesDir, topN, only: options.principles });

  // Optional embeddings refinement: boost principles named by the semantic
  // router when the gateway is reachable; silent fallback otherwise.
  if (options.embeddings !== false && ranked.length > 0) {
    try {
      const { classifyPromptSemantic } = await import('./router.mjs');
      const sem = await classifyPromptSemantic(text.slice(0, 2000), {
        baseUrl: options.baseUrl,
        rootDir: options.rootDir || join(__dirname, '..')
      });
      if (sem && Array.isArray(sem.candidates)) {
        const boost = new Set(sem.candidates.map(c => c.type));
        ranked.sort((a, b) => (boost.has(b.id) ? 1 : 0) - (boost.has(a.id) ? 1 : 0) || b.score - a.score);
      }
    } catch {
      // Keyword order stands.
    }
  }

  const chunks = splitDiffIntoChunks(text, options.maxChunkChars || GRADER_MAX_CHUNK_CHARS);
  const chunked = chunks.length > 1 || chunks.some(c => c.truncated);
  const excerpt = chunks
    .map(c => `[chunk ${c.index + 1}/${c.total}${c.truncated ? ' truncated' : ''} :: ${c.header}]\n${c.body.slice(0, options.maxChunkChars || GRADER_MAX_CHUNK_CHARS)}`)
    .join('\n\n')
    .slice(0, (options.maxChunkChars || GRADER_MAX_CHUNK_CHARS) * 2);

  const prompt = buildGradingPrompt({ excerpt, principles: ranked, chunked });

  let model = options.model;
  if (!model) {
    try {
      const state = await fetchModelHitchState(options.baseUrl, { timeoutMs: options.timeoutMs });
      try {
        const budget = resolveBudgetMapping({ tier: getStoredBudget().tier, source: getStoredBudget().source, state });
        model = budget.models['judgment and prose'];
      } catch {
        model = resolveRoleMapping(state).models['judgment and prose'];
      }
    } catch {
      model = 'judgment-and-prose';
    }
  }

  const chat = options.chat || (({ model: m, messages }) => sendChat({ model: m, messages, baseUrl: options.baseUrl, temperature: 0.2, timeoutMs: options.timeoutMs }));
  const messages = [{ role: 'user', content: prompt }];

  let raw = await chat({ model, messages });
  const content = typeof raw === 'string' ? raw : raw?.content || '';
  try {
    const parsed = extractJson(content);
    const checked = validateVerdicts(parsed);
    if (!checked.ok) throw new Error(checked.error);
    return { verdicts: checked.verdicts, chunked, principles: ranked.map(r => r.id), model, raw: content };
  } catch {
    // Retry once, then report a parse error rather than fabricating verdicts.
    const retry = await chat({ model, messages: [...messages, { role: 'user', content: 'Your previous reply was not a valid JSON array. Reply with ONLY the JSON array.' }] });
    const retryContent = typeof retry === 'string' ? retry : retry?.content || '';
    try {
      const parsed = extractJson(retryContent);
      const checked = validateVerdicts(parsed);
      if (!checked.ok) throw new Error(checked.error);
      return { verdicts: checked.verdicts, chunked, principles: ranked.map(r => r.id), model, raw: retryContent, retried: true };
    } catch (err) {
      return {
        verdicts: [],
        chunked,
        principles: ranked.map(r => r.id),
        model,
        raw: retryContent,
        retried: true,
        parseError: err?.message || 'Model response was not valid JSON; no verdicts fabricated'
      };
    }
  }
}

export function formatVerdictTable(verdicts) {
  const rows = (verdicts || []).map(v => `  ${(v.principle || '').padEnd(38)} ${(v.applies ? 'applies' : 'n/a').padEnd(8)} ${(v.verdict || '').padEnd(5)} ${(v.rationale || '').slice(0, 90)}`);
  return ['  principle                              scope    verdict rationale', ...rows].join('\n');
}
