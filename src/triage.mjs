import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePlaybookTriggers, ZStack } from './sdk.mjs';
import { estimateTokens } from './context.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TRIAGE_DEFAULT_BUDGET_TOKENS = 12000;
export const TRIAGE_MAX_CANDIDATES = 3;
export const TRIAGE_HEURISTIC_ONLY_NOTICE = '[!] heuristic only: live model triage unavailable, rankings are keyword-based';

function decodeInput(input) {
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  return String(input || '');
}

/**
 * Cap triage input with the context.mjs budgeting convention (~4 chars/token).
 * Over budget: keep head + tail with an explicit omission marker, unless
 * noPrune is set (then abort instead of trimming).
 */
export function capTriageInput(input, options = {}) {
  const budgetTokens = options.budgetTokens || TRIAGE_DEFAULT_BUDGET_TOKENS;
  const text = decodeInput(input);
  const estimated = estimateTokens(text);
  if (estimated <= budgetTokens) {
    return { text, trimmed: false, estimatedTokens: estimated, budgetTokens, note: null };
  }
  if (options.noPrune) {
    throw new Error(
      `Triage input (~${estimated} tokens) exceeds the budget of ${budgetTokens} tokens and --no-prune was set. Nothing was sent.`
    );
  }
  const lines = text.split('\n');
  const budgetChars = budgetTokens * 4;
  const headChars = Math.floor(budgetChars * 0.6);
  const tailChars = budgetChars - headChars - 120;
  let head = '';
  let used = 0;
  let headCount = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headChars) break;
    head += line + '\n';
    used += line.length + 1;
    headCount++;
  }
  const tail = text.slice(-Math.max(0, tailChars));
  const omitted = lines.length - headCount - tail.split('\n').length + 1;
  const capped = `${head}[... omitted lines ${headCount + 1}-${Math.max(headCount + 1, headCount + omitted)} ...]\n${tail}`;
  return {
    text: capped,
    trimmed: true,
    estimatedTokens: estimated,
    budgetTokens,
    note: `input trimmed to budget (${lines.length} lines, ~${estimated} tokens)`
  };
}

/** Split one log into distinct failure blocks; never merge separate failures. */
export function splitFailures(text) {
  const input = decodeInput(text).trim();
  if (!input) return [];
  const rawBlocks = input.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (rawBlocks.length <= 1) return rawBlocks.length ? [rawBlocks[0]] : [];
  // Keep stack-trace continuations (indented/at-lines) glued to their header.
  const blocks = [];
  let current = '';
  for (const block of rawBlocks) {
    const looksNew = /^(error|exception|fail|.*(Error|Exception|FAILED|failed))[:\s]/im.test(block.slice(0, 200)) ||
      /^\s*(FAIL|ERROR)\b/m.test(block);
    if (looksNew && current) {
      blocks.push(current);
      current = block;
    } else {
      current = current ? current + '\n\n' + block : block;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function triggerOf(id, rootDir) {
  try {
    const file = join(rootDir || join(__dirname, '..'), 'playbooks', `${id}.md`);
    if (!existsSync(file)) return 'General task';
    const content = readFileSync(file, 'utf8');
    const m = content.match(/> \*\*Trigger:\*\*\s*(.+)/i);
    return m ? m[1].trim() : 'General task';
  } catch {
    return 'General task';
  }
}

function nextCommandsFor(playbook, snippet) {
  const short = snippet.replace(/\s+/g, ' ').trim().slice(0, 60);
  return [
    `zstack task ${playbook} "${short}${snippet.length > 60 ? '...' : ''}"`,
    `zstack grade --file <diff-with-fix>.patch`
  ];
}

/**
 * Deterministic heuristic pass: score each failure block with the shared
 * keyword/specificity scorer, aggregate by playbook (best block wins).
 */
export function heuristicTriage(text, options = {}) {
  const maxCandidates = options.maxCandidates || TRIAGE_MAX_CANDIDATES;
  const rootDir = options.rootDir || join(__dirname, '..');
  const blocks = splitFailures(text);
  if (blocks.length === 0) return [];
  const best = new Map();
  blocks.forEach((block, blockIndex) => {
    for (const c of scorePlaybookTriggers(block).slice(0, 5)) {
      const prev = best.get(c.type);
      if (!prev || c.score > prev.score) {
        best.set(c.type, { ...c, blockIndex, snippet: block.slice(0, 200) });
      }
    }
  });
  // Fallback when nothing matches: all blocks point at feature investigation.
  if (best.size === 0) {
    const snippet = blocks[0].slice(0, 200);
    return [{
      playbook: 'investigation',
      trigger: triggerOf('investigation', rootDir),
      confidence: 0.2,
      reason: 'no keyword match; defaulting to investigation',
      nextCommands: nextCommandsFor('investigation', snippet)
    }];
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates)
    .map(c => ({
      playbook: c.type,
      trigger: triggerOf(c.type, rootDir),
      confidence: Math.min(0.95, 0.4 + c.score / 10),
      reason: c.reason,
      nextCommands: nextCommandsFor(c.type, c.snippet)
    }));
}

function knownPlaybookIds(rootDir) {
  try {
    const dir = join(rootDir || join(__dirname, '..'), 'playbooks');
    return new Set(readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
  } catch {
    return new Set();
  }
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildLivePrompt(cappedText, heuristic, knownIds) {
  return `You triage software failures into zstack playbooks. Read the failure output and the heuristic candidates, then reply with ONLY a JSON object shaped {"playbook": "<id>", "confidence": <0-1>, "rationale": "<one sentence>", "nextSteps": ["<step>", ...]}. The playbook MUST be one of: ${[...knownIds].sort().join(', ')}. Prefer a heuristic candidate unless the output clearly indicates otherwise.

<FAILURE>
${cappedText.slice(0, 6000)}
</FAILURE>

<HEURISTIC>
${JSON.stringify(heuristic)}
</HEURISTIC>`;
}

/**
 * Turn raw failure output into a playbook decision.
 * Live path uses the existing ZStack.runRole plumbing (provider-neutral);
 * unreachable gateways or non-conforming model JSON retry once, then fall
 * back to the heuristic with an explicit notice. Never fabricates.
 */
export async function triageFailure(options = {}) {
  const { input, maxCandidates = TRIAGE_MAX_CANDIDATES, live = true } = options;
  const rootDir = options.rootDir || join(__dirname, '..');
  const text = decodeInput(input);
  if (!text.trim()) {
    throw new Error('Empty triage input: provide test output, a stack trace, or logs');
  }
  const capped = capTriageInput(text, { budgetTokens: options.budgetTokens, noPrune: options.noPrune });
  const heuristic = heuristicTriage(capped.text, { maxCandidates, rootDir });
  const notes = [];
  if (capped.trimmed && capped.note) notes.push(capped.note);

  if (!live) {
    return { candidates: heuristic, heuristicOnly: true, notice: null, notes };
  }

  const knownIds = knownPlaybookIds(rootDir);
  const runRole = options.runRole || (async (prompt) => {
    const z = new ZStack({ baseUrl: options.baseUrl, rootDir, timeoutMs: options.timeoutMs });
    const res = await z.runRole('judgment and prose', prompt, { timeoutMs: options.timeoutMs });
    return res.content;
  });

  const ask = async () => {
    const content = await runRole(buildLivePrompt(capped.text, heuristic, knownIds));
    const parsed = extractJsonArray(content);
    if (!parsed || typeof parsed.playbook !== 'string' || !knownIds.has(parsed.playbook)) {
      const dropped = parsed?.playbook;
      if (dropped !== undefined) notes.push(`dropped unknown playbook id from model: ${String(dropped).slice(0, 80)}`);
      throw new Error(`Model returned unknown playbook id: ${String(dropped).slice(0, 80)}`);
    }
    if (typeof parsed.confidence !== 'number' || !Array.isArray(parsed.nextSteps)) {
      throw new Error('Model response does not conform to the triage contract');
    }
    const trigger = triggerOf(parsed.playbook, rootDir);
    const snippet = capped.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    return [{
      playbook: parsed.playbook,
      trigger,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: parsed.rationale || 'live model triage',
      nextCommands: [...(parsed.nextSteps.slice(0, 3).map(s => `zstack task ${parsed.playbook} "${String(s).slice(0, 60)}"`)), ...nextCommandsFor(parsed.playbook, snippet)].slice(0, 3)
    }];
  };

  try {
    const candidates = await ask();
    return { candidates, heuristicOnly: false, notice: null, notes };
  } catch {
    try {
      const candidates = await ask();
      return { candidates, heuristicOnly: false, notice: null, notes, retried: true };
    } catch {
      return { candidates: heuristic, heuristicOnly: true, notice: TRIAGE_HEURISTIC_ONLY_NOTICE, notes };
    }
  }
}
