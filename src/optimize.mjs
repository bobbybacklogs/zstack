/**
 * Prompt optimization: rewrite a raw request into a task prompt worth running.
 *
 * The reader types a thought; zstack classifies it, then asks a model to turn
 * it into one clear, actionable prompt grounded in the playbook the request
 * matched. The rewritten text goes back into the composer for the reader to
 * review and send. Nothing is dispatched from here: this only shapes the text.
 *
 * The rules are deliberately conservative. A model asked to "improve" a prompt
 * will happily invent a design, and a prompt that promises work the author never
 * asked for is worse than the rough one it replaced. So the instruction is to
 * preserve every detail and invent nothing, and the model's output is cleaned of
 * the wrappers models add (fences, quotes, a "Optimized prompt:" label) before
 * it is handed back.
 */

import { sendChat } from './connector.mjs';

/** Longest raw prompt accepted for optimization. */
export const OPTIMIZE_MAX_PROMPT_CHARS = 8000;

/** How the model is told to rewrite. Kept here so the CLI, SDK, and server agree. */
export const OPTIMIZE_RULES = [
  'You rewrite a terse engineering request into one clear, actionable task prompt.',
  '',
  'Rules:',
  "- Keep the author's intent and every concrete detail. Invent nothing: no new files, APIs, commands, or requirements.",
  '- State the deliverable, the constraint, and what "done" looks like when the request implies them.',
  '- If the request names files, functions, errors, or commands, keep them exact.',
  '- Leave a genuine unknown as a placeholder the author can fill in rather than guessing.',
  '- One short paragraph, or a short list when the request has distinct parts. Active voice, imperative, no preamble, no filler, no em-dashes.',
  '- Reply with the rewritten prompt only. No quotes, no code fences, no label, no explanation.'
].join('\n');

/**
 * The system prompt for one optimization, with the classification folded in.
 *
 * The playbook and principle names are context for the rewrite, not text to
 * echo: a prompt that recites engineering methodology is longer without being
 * clearer.
 */
export function buildOptimizeSystemPrompt({ playbook, playbookTitle, principles } = {}) {
  const lines = [OPTIMIZE_RULES];
  if (typeof playbook === 'string' && playbook !== '') {
    lines.push(`Task type: ${playbook}${playbookTitle ? ` (${playbookTitle})` : ''}.`);
  }
  if (Array.isArray(principles) && principles.length > 0) {
    lines.push(`Relevant zstack principles: ${principles.join(', ')}.`);
  }
  return lines.join('\n\n');
}

/**
 * Strip the wrappers a model adds around an answer, leaving the prompt.
 *
 * Order matters: a label can precede a fence, so labels are removed, then a
 * fence, then a label that lived inside the fence, then one layer of quotes.
 */
export function extractOptimizedPrompt(text) {
  let out = String(text ?? '').trim();
  const stripLabel = (value) => value.replace(/^(?:optimized\s+prompt|improved\s+prompt|prompt)\s*:\s*/i, '');
  out = stripLabel(out);
  const fence = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) out = fence[1].trim();
  out = stripLabel(out);
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim();
    }
  }
  return out.trim();
}

/** Problems with an optimization request, or none. */
export function validateOptimizeRequest(input = {}) {
  const problems = [];
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt === '') problems.push('A prompt is required to optimize.');
  else if (prompt.length > OPTIMIZE_MAX_PROMPT_CHARS) {
    problems.push(`A prompt to optimize is at most ${OPTIMIZE_MAX_PROMPT_CHARS} characters.`);
  }
  if (input.playbook !== undefined && typeof input.playbook !== 'string') {
    problems.push('playbook must be a string.');
  }
  return problems;
}

/**
 * Rewrite one prompt.
 *
 * `deps.chat` is injectable so the rewrite can be tested without a network, and
 * defaults to a gateway call using the resolved model. Resolves with the
 * cleaned prompt and the model that produced it; throws with `kind:
 * 'empty-optimization'` when the model returned nothing usable rather than
 * handing back an empty composer.
 */
export async function optimizePrompt(options = {}, deps = {}) {
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (prompt === '') throw new Error('A prompt is required to optimize.');

  const messages = [
    { role: 'system', content: buildOptimizeSystemPrompt(options) },
    { role: 'user', content: prompt }
  ];
  const chat = deps.chat || (({ model, messages: msgs }) => sendChat({
    model,
    messages: msgs,
    baseUrl: deps.baseUrl,
    temperature: deps.temperature ?? 0.2,
    maxTokens: deps.maxTokens,
    timeoutMs: deps.timeoutMs,
    signal: deps.signal
  }));

  const res = await chat({ model: deps.model, messages });
  const optimized = extractOptimizedPrompt(res?.content || '');
  if (optimized === '') {
    const err = new Error('The model returned nothing usable to put in the prompt.');
    err.kind = 'empty-optimization';
    throw err;
  }
  return {
    prompt: optimized,
    model: res?.model ?? deps.model ?? null,
    usage: res?.usage ?? null,
    durationMs: res?.durationMs ?? null
  };
}
