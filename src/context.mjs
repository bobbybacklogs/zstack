import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 12000;
/** Rough heuristic: ~4 chars per token. Deliberately conservative. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function readTextSafe(fullPath) {
  try {
    const buf = readFileSync(fullPath);
    if (isProbablyBinary(buf)) return { skipped: true, reason: 'binary' };
    try {
      return { content: buf.toString('utf8') };
    } catch {
      return { content: buf.toString('latin1') };
    }
  } catch (err) {
    return { skipped: true, reason: err?.message || 'unreadable' };
  }
}

/**
 * Keep file headers and export surface first: leading imports/comments plus
 * lines that declare the public surface (exports, functions, classes).
 */
export function extractHeader(content, maxLines = 40) {
  const lines = String(content).split('\n');
  const header = [];
  for (const line of lines) {
    if (header.length >= maxLines) break;
    if (
      /^\s*(import|export|const|let|var|function|class|interface|type|#|<!--|\/\*|\*|\/\/)/.test(line) ||
      line.trim() === ''
    ) {
      header.push(line);
    } else if (header.length < 12) {
      header.push(line);
    } else {
      break;
    }
  }
  return header.join('\n');
}

/**
 * Decide what fits in the context budget. Deterministic pruning:
 * file headers/exports first, truncated bodies with explicit omission markers,
 * least-relevant (trailing) principles dropped with a note.
 *
 * Returns { withinBudget, estimatedTokens, budgetTokens, filesContext,
 *   playbookText, principlesText, trimmed[], omittedPrinciples[],
 *   aborted, abortReason }.
 */
export function planContext(options = {}) {
  const {
    files = [],
    playbookText = '',
    principleTexts = {},
    principleNames = [],
    budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
    workspaceDir = process.cwd(),
    noPrune = false,
    maxFileBodyChars = 2000
  } = options;

  const trimmed = [];
  const notes = { unreadable: [], binary: [] };

  const playbookTokens = estimateTokens(playbookText);
  if (playbookTokens > budgetTokens) {
    return {
      withinBudget: false,
      estimatedTokens: playbookTokens,
      budgetTokens,
      filesContext: '',
      playbookText,
      principlesText: '',
      trimmed,
      omittedPrinciples: principleNames,
      aborted: true,
      abortReason: `Context budget (${budgetTokens} tokens) is too small for the playbook alone (~${playbookTokens} tokens). Increase the budget; nothing was sent.`
    };
  }

  // Build per-file blocks at full fidelity first.
  const fileBlocks = [];
  for (const filePath of files) {
    const fullPath = join(workspaceDir, filePath);
    if (!existsSync(fullPath)) {
      trimmed.push(`omitted file ${filePath}: not found on disk`);
      fileBlocks.push({ path: filePath, text: `### File: ${filePath} (file not found on disk)`, tokens: estimateTokens(filePath) });
      continue;
    }
    const read = readTextSafe(fullPath);
    if (read.skipped) {
      const why = read.reason === 'binary' ? 'binary file skipped' : `unreadable (${read.reason})`;
      trimmed.push(`omitted file ${filePath}: ${why}`);
      fileBlocks.push({ path: filePath, text: `### File: ${filePath} (${why})`, tokens: 8 });
      continue;
    }
    fileBlocks.push({
      path: filePath,
      text: `### File: ${filePath}\n\`\`\`\n${read.content}\n\`\`\``,
      tokens: estimateTokens(read.content),
      raw: read.content
    });
  }

  const principleEntries = principleNames.map(name => ({
    name,
    text: principleTexts[name] || `### Principle: ${name}`,
    tokens: estimateTokens(principleTexts[name] || name)
  }));

  const totalTokens =
    playbookTokens +
    fileBlocks.reduce((n, b) => n + b.tokens, 0) +
    principleEntries.reduce((n, p) => n + p.tokens, 0);

  if (totalTokens <= budgetTokens) {
    return {
      withinBudget: true,
      estimatedTokens: totalTokens,
      budgetTokens,
      filesContext: fileBlocks.length > 0
        ? '\n\n## Attached Context Files:\n' + fileBlocks.map(b => b.text).join('\n\n')
        : '',
      playbookText,
      principlesText: principleEntries.map(p => p.text).join('\n\n'),
      trimmed,
      omittedPrinciples: [],
      aborted: false,
      abortReason: null
    };
  }

  if (noPrune) {
    return {
      withinBudget: false,
      estimatedTokens: totalTokens,
      budgetTokens,
      filesContext: '',
      playbookText,
      principlesText: '',
      trimmed: [...trimmed, `over budget (~${totalTokens} > ${budgetTokens} tokens) and --no-prune set: dispatch aborted, nothing was sent`],
      omittedPrinciples: principleNames,
      aborted: true,
      abortReason: `Estimated ~${totalTokens} tokens exceeds budget of ${budgetTokens} tokens and --no-prune was set. Nothing was sent.`
    };
  }

  // Over budget: prune deterministically. Files first, then trailing principles.
  let remaining = budgetTokens - playbookTokens;
  const keptPrinciples = [...principleEntries];
  const omittedPrinciples = [];
  while (keptPrinciples.length > 2 && remaining < keptPrinciples.reduce((n, p) => n + p.tokens, 0)) {
    const dropped = keptPrinciples.pop();
    omittedPrinciples.push(dropped.name);
    trimmed.push(`omitted principle ${dropped.name} (~${dropped.tokens} tokens) to fit budget`);
  }

  const principleTokens = keptPrinciples.reduce((n, p) => n + p.tokens, 0);
  remaining -= principleTokens;

  const prunedBlocks = [];
  for (const block of fileBlocks) {
    if (!block.raw) {
      prunedBlocks.push(block.text);
      remaining -= block.tokens;
      continue;
    }
    if (block.tokens <= remaining) {
      prunedBlocks.push(block.text);
      remaining -= block.tokens;
      continue;
    }
    const header = extractHeader(block.raw);
    const headerTokens = estimateTokens(header);
    if (headerTokens + 20 > remaining && prunedBlocks.length > 0) {
      const totalLines = block.raw.split('\n').length;
      trimmed.push(`omitted file ${block.path} body entirely (${totalLines} lines) to fit budget; header kept`);
      prunedBlocks.push(`### File: ${block.path}\n\`\`\`\n${header}\n[... omitted lines 1-${totalLines} of ${block.path}: body truncated to fit context budget ...]\n\`\`\``);
      remaining -= (headerTokens + 20);
      continue;
    }
    const bodyBudget = Math.max(0, remaining - headerTokens - 20);
    const bodyChars = Math.min(block.raw.length, maxFileBodyChars, bodyBudget * 4);
    const totalLines = block.raw.split('\n').length;
    const keptLines = block.raw.slice(0, bodyChars).split('\n').length;
    trimmed.push(`truncated file ${block.path}: kept header + lines 1-${keptLines} of ${totalLines} to fit budget`);
    prunedBlocks.push(
      `### File: ${block.path}\n\`\`\`\n${header}\n${block.raw.slice(0, bodyChars)}\n[... omitted lines ${keptLines + 1}-${totalLines} of ${block.path}: truncated to fit context budget ...]\n\`\`\``
    );
    remaining -= estimateTokens(prunedBlocks[prunedBlocks.length - 1]);
  }

  if (omittedPrinciples.length > 0) {
    trimmed.push(`principles omitted: ${omittedPrinciples.join(', ')} (least-relevant trailing principles dropped first)`);
  }

  return {
    withinBudget: false,
    estimatedTokens: totalTokens,
    budgetTokens,
    filesContext: prunedBlocks.length > 0 ? '\n\n## Attached Context Files:\n' + prunedBlocks.join('\n\n') : '',
    playbookText,
    principlesText: keptPrinciples.map(p => p.text).join('\n\n'),
    trimmed,
    omittedPrinciples,
    aborted: false,
    abortReason: null
  };
}
